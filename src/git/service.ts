/**
 * GitService —— 高层只读 API（设计方案 6.4）。
 */
import type { Commit, CommitDetail, DiffPayload, FileChange, LogFilter, RepoState } from '../common/models';
import { GitError, type GitExecutor } from './executor';
import {
  LOG_FORMAT, EACH_REF_FORMAT, parseLog, parseForEachRef, parseFiles, parseStatus,
  parseUnifiedDiff, countDiffLines, buildRefTree, type RawRef, type StatusInfo,
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
}
