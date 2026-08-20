/**
 * GitService —— 高层只读 API（设计方案 6.4）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Commit, CommitDetail, DiffPayload, FileChange, FileEntry, LogFilter, RepoState, DiffLine, DiffHunk } from '../common/models';
import { GitError, type GitExecutor } from './executor';
import {
  LOG_FORMAT, EACH_REF_FORMAT, parseLog, parseForEachRef, parseFiles, parseStatus,
  parseUnifiedDiff, countDiffLines, buildRefTree, parseStatusEntries, type RawRef, type StatusInfo,
} from './parse';

/** 空树的固定哈希（root 提交 diff 基线） */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const DIFF_MAX_LINES = 5000;

export class GitService {
  constructor(private readonly exec: GitExecutor) {}

  async refsOf(root: string): Promise<RawRef[]> {
    const r = await this.exec.exec(root, [
      'for-each-ref', `--format=${EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags',
    ]);
    return parseForEachRef(r.stdout);
  }

  async statusOf(root: string): Promise<StatusInfo> {
    const r = await this.exec.exec(root, ['status', '--porcelain=v1', '-b']);
    return parseStatus(r.stdout);
  }

  async headShaOf(root: string): Promise<string | null> {
    try {
      const r = await this.exec.exec(root, ['rev-parse', 'HEAD']);
      return r.stdout.trim() || null;
    } catch {
      return null;   // 空仓库
    }
  }

  async remotesOf(root: string): Promise<string[]> {
    const r = await this.exec.exec(root, ['remote']);
    return r.stdout.split('\n').map(s => s.trim()).filter(Boolean);
  }

  /** 分页获取提交；LogFilter = ref（null 时 --all）+ 作者 + 时间段 */
  async commitsPage(root: string, filter: LogFilter, offset: number, limit: number, ctx?: { localBranches: Set<string>; remoteBranches: Set<string> }): Promise<{ commits: Commit[]; hasMore: boolean }> {
    const args = [
      'log', '--topo-order', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`,
      '-n', String(limit), '--skip', String(offset),
    ];
    if (filter.ref) args.push(filter.ref); else args.push('--all');
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (filter.author) args.push(`--author=${filter.author}`);
    if (DATE_RE.test(filter.since)) args.push(`--since=${filter.since} 00:00:00`);
    if (DATE_RE.test(filter.until)) args.push(`--until=${filter.until} 23:59:59`);
    try {
      const r = await this.exec.exec(root, args, { timeoutMs: 60_000 });
      const commits = parseLog(r.stdout, ctx ?? {});
      return { commits, hasMore: commits.length === limit };
    } catch (e) {
      if (e instanceof GitError && /does not have any commits yet|ambiguous argument/i.test(e.message)) {
        return { commits: [], hasMore: false };
      }
      throw e;
    }
  }

  /** 汇总某仓库当前呈现所需全部数据（首屏页） */
  async buildState(root: string, repoId: string, filter: LogFilter, pageSize: number, stateVersion: number): Promise<RepoState> {
    const [refs, status, headSha] = await Promise.all([
      this.refsOf(root),
      this.statusOf(root),
      this.headShaOf(root),
    ]);
    const headBranch = status.detached ? undefined : status.branch;
    const tree = buildRefTree(refs, headBranch);
    const ctx = {
      localBranches: new Set(tree.branches.map(b => b.name)),
      remoteBranches: new Set(tree.remotes.flatMap(g => g.branches.map(b => b.name))),
    };
    const { commits, hasMore } = headSha
      ? await this.commitsPage(root, filter, 0, pageSize, ctx)
      : { commits: [] as Commit[], hasMore: false };
    return {
      repoId,
      head: { sha: headSha ?? '', branch: headBranch, detached: status.detached },
      branches: tree.branches,
      remotes: tree.remotes,
      tags: tree.tags,
      status: { dirtyCount: status.dirtyCount },
      filterRef: filter.ref,
      logFilter: { author: filter.author, since: filter.since, until: filter.until },
      commits,
      commitsLoaded: commits.length,
      hasMore,
      stateVersion,
    };
  }

  /** 提交详情：变更文件（merge 按 first-parent 口径，root 用 --empty 基线） */
  async detailOf(root: string, commit: Commit): Promise<CommitDetail> {
    const sha = commit.sha;
    // 注意：diff-tree 对 merge 默认无输出且 --first-parent 不展开，须显式给出第一父
    const target = commit.parents.length >= 2 ? [commit.parents[0], sha] : ['--root', sha];
    const ns = await this.exec.exec(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', ...target]);
    const num = await this.exec.exec(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--numstat', ...target]);
    const files: FileChange[] = parseFiles(ns.stdout, num.stdout);
    return { ...commit, files, filesTruncated: false };
  }

  /** 单文件差异（内联预览用）；commit 模式自动以第一父提交为基线 */
  async diffOf(root: string, mode: 'commit' | 'worktree' | 'range', sha: string, path: string, base?: string): Promise<DiffPayload> {
    let baseRef = base;
    if (!baseRef && mode === 'commit') {
      const parent = await this.firstParentOf(root, sha);
      baseRef = parent ?? EMPTY_TREE;   // root 提交：与空树比较
    }
    const refs: string[] =
      mode === 'worktree' ? [sha]
        : [baseRef ?? EMPTY_TREE, sha];
    // 二进制判定
    const num = await this.exec.exec(root, ['diff', '--numstat', '-M', ...refs, '--', path]);
    const first = num.stdout.split('\n').find(Boolean);
    if (first && first.split('\t')[0] === '-') return { kind: 'binary' };

    const r = await this.exec.exec(root, ['diff', '--unified=3', '--no-color', '-M', ...refs, '--', path]);
    if (countDiffLines(r.stdout) > DIFF_MAX_LINES) return { kind: 'tooLarge' };
    const diff = parseUnifiedDiff(r.stdout);
    if (diff.hunks.length === 0) return { kind: 'empty' };
    return { kind: 'diff', diff };
  }

  private async firstParentOf(root: string, sha: string): Promise<string | null> {
    const r = await this.exec.exec(root, ['rev-list', '--parents', '-n', '1', sha]);
    const parts = r.stdout.trim().split(/\s+/).filter(Boolean);
    return parts.length > 1 ? parts[1] : null;
  }

  /** 历史版本文件内容（diffProvider / 只读打开） */
  async contentAt(root: string, ref: string, path: string): Promise<string> {
    try {
      const r = await this.exec.exec(root, ['show', `${ref}:${path}`]);
      return r.stdout;
    } catch {
      return '';   // 该版本不存在此文件（新增/删除侧）
    }
  }

  // ---------- 工作副本（Commit 功能） ----------

  /**
   * 工作副本状态矩阵：staged / unstaged 两组 FileEntry（含各自 numstat 增删）。
   * 双态文件在两组各出现一行；未跟踪归入 unstaged 组；merging = 存在未解决冲突。
   */
  async workingCopyOf(root: string): Promise<{ staged: FileEntry[]; unstaged: FileEntry[]; merging: boolean; dirtyCount: number }> {
    const r = await this.exec.exec(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const { entries, merging } = parseStatusEntries(r.stdout);
    const staged: FileEntry[] = [];
    const unstaged: FileEntry[] = [];
    for (const e of entries) {
      if (e.staged) staged.push({ ...e });
      if (e.unstaged || e.untracked) unstaged.push({ ...e });
    }
    const byPath = (a: FileEntry, b: FileEntry) => a.path.localeCompare(b.path);
    staged.sort(byPath);
    unstaged.sort(byPath);
    // 各组增删统计：cached numstat（staged 侧）与 worktree numstat（unstaged 侧）
    await this.fillNumstat(root, staged, true).catch(() => undefined);
    await this.fillNumstat(root, unstaged, false).catch(() => undefined);
    return { staged, unstaged, merging, dirtyCount: entries.length };
  }

  private async fillNumstat(root: string, entries: FileEntry[], cached: boolean): Promise<void> {
    if (!entries.length) return;
    const r = await this.exec.exec(root, cached ? ['diff', '--cached', '--numstat', '-M'] : ['diff', '--numstat', '-M']);
    const map = new Map<string, [number | undefined, number | undefined]>();
    for (const line of r.stdout.split('\n')) {
      if (!line.trim()) continue;
      const f = line.split('\t');
      if (f.length < 3) continue;
      const binary = f[0] === '-' || f[1] === '-';
      map.set(f[2], [binary ? undefined : Number(f[0]), binary ? undefined : Number(f[1])]);
    }
    for (const e of entries) {
      const st = map.get(e.path);
      if (st) { e.additions = st[0]; e.deletions = st[1]; }
    }
  }

  /** HEAD 提交概要（空状态 / amend 载入） */
  async headCommitOf(root: string): Promise<{ shortSha: string; subject: string; body: string; date: string } | null> {
    try {
      const r = await this.exec.exec(root, ['log', '-1', '--pretty=format:%h%x00%s%x00%b%x00%ad', '--date=iso-strict']);
      const f = r.stdout.split('\0');
      if (f.length < 4 || !f[0]) return null;
      return { shortSha: f[0], subject: f[1], body: f[2].replace(/\n+$/, ''), date: f[3] };
    } catch {
      return null;   // 空仓库
    }
  }

  /**
   * 未跟踪文件预览：读取内容渲染为「全新增」视图（文本 ≤1MB；二进制 → binary）。
   * absFile 由调用方（panel.safeJoin）做过根内校验。
   */
  untrackedDiffOf(absFile: string): DiffPayload {
    let buf: Buffer;
    try {
      const st = fs.statSync(absFile);
      if (st.size > 1024 * 1024) return { kind: 'tooLarge' };
      buf = fs.readFileSync(absFile);
    } catch {
      return { kind: 'empty' };
    }
    if (buf.includes(0)) return { kind: 'binary' };
    const text = buf.toString('utf8');
    if (text.length > DIFF_MAX_LINES * 200) return { kind: 'tooLarge' };
    const rawLines = text.split('\n');
    if (rawLines.length > DIFF_MAX_LINES) return { kind: 'tooLarge' };
    const lines: DiffLine[] = rawLines.map((t, i) => ({ kind: 'add', newNo: i + 1, text: t }));
    // 分块（每 300 行一个 hunk）避免单个超大节点
    const hunks: DiffHunk[] = [];
    for (let i = 0; i < lines.length; i += 300) {
      hunks.push({ header: `@@ -0,0 +${i + 1},${Math.min(300, lines.length - i)} @@`, oldStart: 0, newStart: i + 1, lines: lines.slice(i, i + 300) });
    }
    if (!hunks.length) return { kind: 'empty' };
    return { kind: 'diff', diff: { hunks, truncated: false } };
  }

  /** 近期提交信息（复用按钮，取 n 条） */
  async recentMessages(root: string, n: number): Promise<{ subject: string; body: string }[]> {
    const { commits } = await this.commitsPage(root, { ref: null, author: '', since: '', until: '' }, 0, n);
    return commits.map(c => ({ subject: c.subject, body: c.body }));
  }

  // ---------- AI 提交信息上下文（设计方案 §5.3/§5.7） ----------

  /** 指示文件扫描结果（.copilot/ 优先，其次 Copilot 官方 .github/ 约定） */
  async collectInstructions(root: string): Promise<{ path: string; content: string }[]> {
    const rels: string[] = [];
    const walk = (dir: string, prefix: string, depth: number): void => {
      let names: string[];
      try { names = fs.readdirSync(path.join(root, dir)); } catch { return; }
      for (const name of names.sort()) {
        const rel = prefix + name;
        const full = path.join(root, rel);
        let st: fs.Stats;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.isDirectory()) { if (depth < 3) walk(rel + '/', rel + '/', depth + 1); continue; }
        if (name.endsWith('.md') && st.size <= 512 * 1024) rels.push(rel);
      }
    };
    walk('.copilot', '.copilot/', 0);
    try {
      const p = path.join(root, '.github', 'copilot-instructions.md');
      if (fs.existsSync(p)) rels.push('.github/copilot-instructions.md');
    } catch { /* ignore */ }
    try {
      for (const name of fs.readdirSync(path.join(root, '.github', 'instructions')).sort()) {
        if (name.endsWith('.instructions.md')) rels.push(`.github/instructions/${name}`);
      }
    } catch { /* 目录不存在 */ }

    const out: { path: string; content: string }[] = [];
    let total = 0;
    const PER_FILE = 4000, TOTAL = 8000;
    for (const rel of rels) {
      if (total >= TOTAL) break;
      let text: string;
      try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
      let clipped = text.slice(0, Math.min(PER_FILE, TOTAL - total));
      if (clipped.length < text.length) clipped += '\n…(truncated)';
      total += clipped.length;
      out.push({ path: rel, content: clipped.trim() });
    }
    return out;
  }

  /** 组装 AI 上下文：已暂存 diff（三级截断，暂存为空回退全部更改）+ 文件统计 + 近期提交风格 + 工程指示文件 */
  async buildCommitContext(root: string, opts: { learnFromHistory: boolean; useInstructions?: boolean }): Promise<{
    stagedSummary: string;
    stagedDiff: string;
    recentSubjects: string[];
    instructions: { path: string; content: string }[];
    diffTruncated: boolean;
  }> {
    const diffArgs = (cached: boolean) =>
      cached ? ['diff', '--cached', '--numstat', '-M'] : ['diff', '--numstat', '-M'];
    let num = await this.exec.exec(root, diffArgs(true));
    let cached = true;
    if (!num.stdout.trim()) {
      // 暂存区为空：回退 HEAD↔工作副本 全部更改（§4.2「基于全部更改生成」）
      num = await this.exec.exec(root, diffArgs(false));
      cached = false;
    }
    const [recent, instructions] = await Promise.all([
      opts.learnFromHistory ? this.recentMessages(root, 10) : Promise.resolve([]),
      opts.useInstructions === false ? Promise.resolve([]) : this.collectInstructions(root),
    ]);
    const summaryLines: string[] = [];
    for (const line of num.stdout.split('\n')) {
      if (!line.trim()) continue;
      const f = line.split('\t');
      if (f.length < 3) continue;
      const binary = f[0] === '-' || f[1] === '-';
      summaryLines.push(` ${binary ? 'B' : '+' + f[0] + '/-' + f[1]}\t${f[2]}`);
    }
    const stagedSummary = summaryLines.join('\n');
    // staged diff：全量拉取后按文件截断（锁文件/产物只保留统计行）
    const full = await this.exec.exec(root, cached
      ? ['diff', '--cached', '--unified=3', '-M']
      : ['diff', '--unified=3', '-M'], { maxBytes: 4 * 1024 * 1024 });
    const { text: stagedDiff, truncated } = truncateCachedDiff(full.stdout, stagedSummary);
    return {
      stagedSummary,
      stagedDiff,
      recentSubjects: recent.map(m => m.subject),
      instructions,
      diffTruncated: truncated,
    };
  }
}

/** 锁文件/压缩产物：不送 diff 内容 */
const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum)(\/|$)|\.min\.(js|css)$/;

/**
 * 已暂存 diff 截断（设计方案 §5.3）：
 * 噪音文件只留一行标注；单文件 >300 行取头 200 + 尾 50；总预算 24K 字符，超限即停并标注。
 */
function truncateCachedDiff(raw: string, summary: string): { text: string; truncated: boolean } {
  if (!raw) return { text: '', truncated: false };
  const parts = raw.split(/(?=^diff --git )/m).filter(Boolean);
  const TOTAL = 24_000;
  let out = '';
  let truncated = false;
  for (const part of parts) {
    const m = /^diff --git a\/(.*) b\/(.*)/.exec(part);
    const name = m?.[2] ?? '';
    if (NOISE_RE.test(name)) {
      out += `diff --git a/${name} b/${name}\n(内容已省略：锁文件/产物，见文件统计)\n`;
      continue;
    }
    const lines = part.split('\n');
    let piece = part;
    if (lines.length > 300) {
      piece = lines.slice(0, 200).join('\n') + '\n…(此文件差异已截断 ' + (lines.length - 250) + ' 行)…\n' + lines.slice(-50).join('\n') + '\n';
      truncated = true;
    }
    if (out.length + piece.length > TOTAL) {
      truncated = true;
      out += '…(其余已暂存文件差异已省略，仅保留统计)\n' + summary + '\n';
      break;
    }
    out += piece;
  }
  return { text: out.trim(), truncated };
}
