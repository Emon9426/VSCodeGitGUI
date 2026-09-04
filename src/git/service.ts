/**
 * GitService —— 高层只读 API（设计方案 6.4）。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Commit, CommitDetail, DiffPayload, FileChange, FileEntry, LogFilter, PullSummaryEntry, RepoState, DiffLine, DiffHunk } from '../common/models';
import { GitError, type GitExecutor } from './executor';
import {
  LOG_FORMAT, SUMMARY_FORMAT, EACH_REF_FORMAT, parseLog, parseSummaryLog, parseForEachRef, parseFiles, parseStatus, parseStatusZ,
  parseUnifiedDiff, countDiffLines, buildRefTree, type RawRef, type StatusInfo,
} from './parse';

/** 空树的固定哈希（root 提交 diff 基线） */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const DIFF_MAX_LINES = 5000;

/**
 * 作者名健全性校验（原文形态）：trim + 限长 100 + 拒绝控制字符。panel.sanitizeLogFilter 存储用。
 * （Issue #5：旧字符白名单曾静默丢弃 dependabot[bot]、含逗号/引号的名字，使作者筛选完全失效。）
 */
export function cleanAuthorName(s: string): string | null {
  const t = s.trim();
  if (!t || t.length > 100 || /[\x00-\x1f\x7f]/.test(t)) return null;
  return t;
}

/**
 * git --author 按 POSIX 基本正则（BRE，git regcomp 未加 REG_EXTENDED）对 "Name <email>" 整串搜索：
 * 仅转义 BRE 元字符（\ . * [ ^ $）做字面匹配——( ) + ? | { } 在 BRE 中本就是字面量，
 * 转义反而变成运算符致失配（实测 Git 2.49：\( 开组）。勿加 ^$ 锚定（匹配目标含 email 尾巴）。
 */
export function escapeAuthorRegex(s: string): string {
  return s.replace(/[\\.*[\]^$]/g, '\\$&');
}

/**
 * 作者筛选参数安全形态：cleanAuthorName 校验 + 正则转义，供 commitsPage 拼进 '--author='
 * （execFile 参数数组 + 等号前缀整体单参数，无 shell 注入面）。
 */
export function safeAuthorName(s: string): string | null {
  const t = cleanAuthorName(s);
  return t === null ? null : escapeAuthorRegex(t);
}

/** 带日期窗口时的补扫上限（panel.commitsFill 用；防 0 命中窗口无界扫描，到达后如实报 hasMore 供续扫） */
export const SCAN_CAP = 20_000;

/** 作者日期窗口（本地时区日界）——与列表显示的 %ad 同口径 */
export interface AuthorDateWindow {
  contains(c: Commit): boolean;
}

/** YYYY-MM-DD → 本地时区当日起点（00:00:00.000）/终点（23:59:59.999）时刻；非法格式返回 undefined */
export function dayBoundMs(ymd: string, endOfDay: boolean): number | undefined {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const t = (endOfDay ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3])).getTime();
  return Number.isNaN(t) ? undefined : t;
}

/** 构造作者日期窗口；两端均缺省时返回 undefined（无过滤） */
export function authorDateWindow(since: string, until: string): AuthorDateWindow | undefined {
  const sinceMs = dayBoundMs(since, false);
  const untilMs = dayBoundMs(until, true);
  if (sinceMs === undefined && untilMs === undefined) return undefined;
  return {
    contains(c: Commit): boolean {
      const t = Date.parse(c.author?.date ?? '');
      if (Number.isNaN(t)) return true;   // 日期解析失败宁可保留显示
      if (sinceMs !== undefined && t < sinceMs) return false;
      if (untilMs !== undefined && t > untilMs) return false;
      return true;
    },
  };
}

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

  /** 一次 status 同时产出分支信息 + 文件矩阵（v0.7.2：替代 -b / -z 各跑一次） */
  async statusFullOf(root: string): Promise<{ info: StatusInfo; entries: FileEntry[]; merging: boolean }> {
    const r = await this.exec.exec(root, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']);
    return parseStatusZ(r.stdout);
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

  /**
   * 分页获取提交；LogFilter = ref（null 时 --all）+ 作者多选（git 侧转义后 OR）+ 时间段 + 纯提交。
   * order：topo（默认，走线规整）/ date（大仓库更快）。
   *
   * 时间段过滤在宿主侧按作者日期（%ad，与列表显示同口径）进行——git --since/--until 按
   * 提交者日期过滤，rebase/cherry-pick 后与显示口径错位，且存在遍历剪枝（tip 提交者日期
   * 早于 since 时整链被剪，Issue #5）。因此带日期窗口时 scanOffset（git --skip 偏移）≠
   * 过滤产出计数：产出可能不足 limit，由 panel.commitsFill 循环补扫凑页（SCAN_CAP 封顶），
   * 调用方须持久化返回的 scanned 作为后续调用的 scanOffset（panel.scanCursors）。
   */
  async commitsPage(root: string, filter: LogFilter, scanOffset: number, limit: number, ctx?: { localBranches: Set<string>; remoteBranches: Set<string> }, order: 'topo' | 'date' = 'topo'): Promise<{ commits: Commit[]; hasMore: boolean; scanned: number }> {
    // 纯提交视图强制日期序：去掉合并提交后拓扑序会把平行支线排成时间倒错
    // （如 B 合并 A 的场景，A 反而排在 B 前）
    const ord = filter.noMerges ? 'date' : order;
    const args = [
      'log',
      ...(ord === 'topo' ? ['--topo-order'] : ['--date-order']),
      '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`,
      '-n', String(limit), '--skip', String(scanOffset),
    ];
    if (filter.noMerges) args.push('--no-merges');
    if (filter.ref) args.push(filter.ref); else args.push('--all');
    for (const a of filter.authors) {
      const name = safeAuthorName(a);
      // 等号形式：值整体作为选项参数（execFile 无 shell，无注入面）；多个 --author 为或关系
      if (name) args.push('--author=' + name);
    }
    try {
      const r = await this.exec.exec(root, args, { timeoutMs: 60_000 });
      const page = parseLog(r.stdout, ctx ?? {});
      const win = authorDateWindow(filter.since, filter.until);
      const commits = win ? page.filter(c => win.contains(c)) : page;
      return { commits, hasMore: page.length === limit, scanned: scanOffset + page.length };
    } catch (e) {
      if (e instanceof GitError && /does not have any commits yet|ambiguous argument/i.test(e.message)) {
        return { commits: [], hasMore: false, scanned: scanOffset };
      }
      throw e;
    }
  }

  /** 汇总某仓库当前呈现所需全部数据（首屏页）；pre 允许复用外层已取的 status 与排序设置（少跑一次）。scanned = 首屏扫描深度（带日期窗口时补页/续扫的游标，Issue #5） */
  async buildState(root: string, repoId: string, filter: LogFilter, pageSize: number, stateVersion: number, pre?: { statusInfo?: StatusInfo; order?: 'topo' | 'date' }): Promise<{ state: RepoState; scanned: number }> {
    const [refs, status, headSha] = await Promise.all([
      this.refsOf(root),
      pre?.statusInfo ? Promise.resolve(pre.statusInfo) : this.statusFullOf(root).then(s => s.info),
      this.headShaOf(root),
    ]);
    const headBranch = status.detached ? undefined : status.branch;
    const tree = buildRefTree(refs, headBranch);
    const ctx = {
      localBranches: new Set(tree.branches.map(b => b.name)),
      remoteBranches: new Set(tree.remotes.flatMap(g => g.branches.map(b => b.name))),
    };
    const { commits, hasMore, scanned } = headSha
      ? await this.commitsPage(root, filter, 0, pageSize, ctx, pre?.order ?? 'topo')
      : { commits: [] as Commit[], hasMore: false, scanned: 0 };
    const state: RepoState = {
      repoId,
      head: { sha: headSha ?? '', branch: headBranch, detached: status.detached },
      branches: tree.branches,
      remotes: tree.remotes,
      tags: tree.tags,
      status: { dirtyCount: status.dirtyCount },
      filterRef: filter.ref,
      logFilter: { authors: filter.authors, since: filter.since, until: filter.until, noMerges: filter.noMerges },
      commits,
      commitsLoaded: commits.length,
      hasMore,
      stateVersion,
    };
    return { state, scanned };
  }

  /** 提交详情：变更文件（merge 按 first-parent 口径，root 用 --empty 基线）；两次 diff-tree 并行（v0.7.2） */
  async detailOf(root: string, commit: Commit): Promise<CommitDetail> {
    const sha = commit.sha;
    // 注意：diff-tree 对 merge 默认无输出且 --first-parent 不展开，须显式给出第一父
    const target = commit.parents.length >= 2 ? [commit.parents[0], sha] : ['--root', sha];
    const [ns, num] = await Promise.all([
      this.exec.exec(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status', ...target]),
      this.exec.exec(root, ['diff-tree', '--no-commit-id', '-r', '-M', '--numstat', ...target]),
    ]);
    const files: FileChange[] = parseFiles(ns.stdout, num.stdout);
    return { ...commit, files, filesTruncated: false };
  }

  /** 单文件差异（内联预览用）；commit 模式自动以第一父提交为基线；numstat 与全量 diff 并行（v0.7.2） */
  async diffOf(root: string, mode: 'commit' | 'worktree' | 'range', sha: string, path: string, base?: string): Promise<DiffPayload> {
    let baseRef = base;
    if (!baseRef && mode === 'commit') {
      const parent = await this.firstParentOf(root, sha);
      baseRef = parent ?? EMPTY_TREE;   // root 提交：与空树比较
    }
    const refs: string[] =
      mode === 'worktree' ? [sha]
        : [baseRef ?? EMPTY_TREE, sha];
    const [num, r] = await Promise.all([
      this.exec.exec(root, ['diff', '--numstat', '-M', ...refs, '--', path]),
      this.exec.exec(root, ['diff', '--unified=3', '--no-color', '-M', ...refs, '--', path]),
    ]);
    const first = num.stdout.split('\n').find(Boolean);
    if (first && first.split('\t')[0] === '-') return { kind: 'binary' };

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
   * 工作副本状态矩阵：staged / unstaged / conflicts 三组 FileEntry。
   * 双态文件在两组各出现一行；未跟踪归入 unstaged 组；冲突条目独立分组（ours/theirs 二选一解决）；
   * merging = 存在未解决冲突；mergeKind = 是否处于普通合并（决定"我的/对方的"文案语义）。
   * pre 允许复用外层已取的 status（v0.7.2：全量刷新周期内不再重复跑 status）。
   */
  async workingCopyOf(root: string, pre?: { entries: FileEntry[]; merging: boolean }): Promise<{ staged: FileEntry[]; unstaged: FileEntry[]; conflicts: FileEntry[]; merging: boolean; mergeActive: boolean; mergeKind: 'merge' | 'rebase' | 'other'; dirtyCount: number }> {
    let entries: FileEntry[];
    let merging: boolean;
    if (pre) {
      entries = pre.entries;
      merging = pre.merging;
    } else {
      const s = await this.statusFullOf(root);
      entries = s.entries;
      merging = s.merging;
    }
    const staged: FileEntry[] = [];
    const unstaged: FileEntry[] = [];
    const conflicts: FileEntry[] = [];
    for (const e of entries) {
      if (e.conflict) { conflicts.push({ ...e }); continue; }
      if (e.staged) staged.push({ ...e });
      if (e.unstaged || e.untracked) unstaged.push({ ...e });
    }
    const byPath = (a: FileEntry, b: FileEntry) => a.path.localeCompare(b.path);
    staged.sort(byPath);
    unstaged.sort(byPath);
    conflicts.sort(byPath);
    // merge=MERGE_HEAD 在（我=:2）；rebase=rebase 目录在（我=:3，ours/theirs 语义反转）；other=cherry-pick 等
    const mergeKind: 'merge' | 'rebase' | 'other' = this.mergeKindOf(root);
    // 各组增删统计：cached numstat（staged 侧）与 worktree numstat（unstaged 侧），两者并行
    await Promise.all([
      this.fillNumstat(root, staged, true).catch(() => undefined),
      this.fillNumstat(root, unstaged, false).catch(() => undefined),
    ]);
    return { staged, unstaged, conflicts, merging, mergeActive: this.mergeActiveOf(root), mergeKind, dirtyCount: entries.length };
  }

  /** 普通合并进行中（MERGE_HEAD 存在）：此时 ours=本地、theirs=合入方 */
  private isMergeInProgress(root: string): boolean {
    try { return fs.statSync(path.join(root, '.git', 'MERGE_HEAD')).isFile(); } catch { return false; }
  }

  /** 变基进行中（交互式 rebase-merge / 非交互 rebase-apply 目录） */
  private isRebaseInProgress(root: string): boolean {
    try {
      return fs.statSync(path.join(root, '.git', 'rebase-merge')).isDirectory()
        || fs.statSync(path.join(root, '.git', 'rebase-apply')).isDirectory();
    } catch { return false; }
  }

  /** 合并会话类型（决定语义侧 → git stage 的映射与完成动作） */
  mergeKindOf(root: string): 'merge' | 'rebase' | 'other' {
    if (this.isMergeInProgress(root)) return 'merge';
    if (this.isRebaseInProgress(root)) return 'rebase';
    return 'other';
  }

  /** 合并/变基进行中（含"冲突已清但未完成提交"的待完成状态） */
  mergeActiveOf(root: string): boolean {
    return this.isMergeInProgress(root) || this.isRebaseInProgress(root);
  }

  /**
   * 合并会话语义标签（UI 栏头 hint）：
   * merge → 他人=MERGE_MSG 提取的分支名（回退 MERGE_HEAD 短 sha）；
   * rebase → 我的=正在重放（HEAD），他人=变基基底（rebase-merge/onto 短 sha）。
   */
  mergeLabelsOf(root: string, kind: 'merge' | 'rebase' | 'other'): { mineRef: string; theirsRef: string } {
    try {
      if (kind === 'merge') {
        const firstLine = fs.readFileSync(path.join(root, '.git', 'MERGE_MSG'), 'utf8').split('\n')[0] ?? '';
        const quoted = firstLine.match(/'([^']+)'/);   // "Merge branch 'x' ..." → x
        if (quoted) return { mineRef: '', theirsRef: quoted[1] };
        const head = fs.readFileSync(path.join(root, '.git', 'MERGE_HEAD'), 'utf8').trim();
        return { mineRef: '', theirsRef: head.slice(0, 7) };
      }
      if (kind === 'rebase') {
        const onto = fs.readFileSync(path.join(root, '.git', 'rebase-merge', 'onto'), 'utf8').trim();
        return { mineRef: 'HEAD', theirsRef: onto ? onto.slice(0, 7) : '' };
      }
    } catch { /* 标签尽力而为，失败留空 */ }
    return { mineRef: '', theirsRef: '' };
  }

  /** 完成合并确认框预览的默认信息（MERGE_MSG 首行；非 merge 返回 undefined） */
  mergeMsgOf(root: string): string | undefined {
    try {
      const first = fs.readFileSync(path.join(root, '.git', 'MERGE_MSG'), 'utf8').split('\n')[0] ?? '';
      return first.trim() || undefined;
    } catch { return undefined; }
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

  /** 仓库全部作者（姓名去重，字母序）——作者多选下拉的候选来源 */
  async authorsOf(root: string): Promise<string[]> {
    const r = await this.exec.exec(root, ['log', '--all', '--format=%an'], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 });
    const names = new Set<string>();
    for (const line of r.stdout.split('\n')) {
      const n = line.trim();
      if (n) names.add(n);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }
  /** 近期提交信息（复用按钮，取 n 条） */
  async recentMessages(root: string, n: number): Promise<{ subject: string; body: string }[]> {
    const { commits } = await this.commitsPage(root, { ref: null, authors: [], since: '', until: '', noMerges: false }, 0, n);
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
    // numstat 上限 512KB：万级文件场景防巨量输出（行数仅供统计，截断无损）
    let num = await this.exec.exec(root, diffArgs(true), { maxBytes: 512 * 1024 });
    let cached = true;
    if (!num.stdout.trim()) {
      // 暂存区为空：回退 HEAD↔工作副本 全部更改（§4.2「基于全部更改生成」）
      num = await this.exec.exec(root, diffArgs(false), { maxBytes: 512 * 1024 });
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
    const stagedSummary = clampSummary(summaryLines);
    // staged diff：全量拉取后按文件截断（锁文件/产物只保留统计行）。
    // 文件多时收紧上下文（unified=1）并降拉取上限至 1MB——最终预算仅 24K 字符，
    // 4MB 全量 diff 在大改动下生成慢且白费（Windows 上 git diff 是主要耗时点）
    const unified = summaryLines.length > 60 ? 1 : 3;
    const full = await this.exec.exec(root, cached
      ? ['diff', '--cached', `--unified=${unified}`, '-M']
      : ['diff', `--unified=${unified}`, '-M'], { maxBytes: 1024 * 1024 });
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
 * 文件统计截断：最多 400 行 / 8K 字符，其余聚合计数。
 * 万级文件时 numstat 全量进 prompt 会撑爆模型上下文（请求挂起），必须封顶。
 */
export function clampSummary(lines: string[]): string {
  const MAX_LINES = 400, MAX_CHARS = 8_000;
  const out: string[] = [];
  let len = 0, i = 0;
  for (; i < lines.length; i++) {
    if (i >= MAX_LINES || len + lines[i].length + 1 > MAX_CHARS) break;
    out.push(lines[i]);
    len += lines[i].length + 1;
  }
  const rest = lines.length - i;
  return rest > 0
    ? out.join('\n') + `\n…(另有 ${rest} 个文件未逐一列出)`
    : out.join('\n');
}

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
