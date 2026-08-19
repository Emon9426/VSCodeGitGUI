/**
 * 数据模型 —— 扩展宿主与 Webview 两侧共享（设计方案第 9 节）。
 * 所有时间字段为 git 输出的 iso-strict 字符串，显示格式化只发生在 Webview。
 */

export interface RepoMeta {
  id: string;            // root 路径 hash(8)
  name: string;          // 目录名
  root: string;          // 绝对路径
  headBranch?: string;
}

export interface GitActor {
  name: string;
  email: string;
  date: string;          // iso-strict
}

export type ChipKind = 'head' | 'remote' | 'tag';

export interface RefChip {
  name: string;
  kind: ChipKind;
  isHead?: boolean;      // HEAD 所指分支
}

export interface Commit {
  sha: string;
  shortSha: string;
  parents: string[];     // 空 = 根提交
  author: GitActor;
  committer: GitActor;
  subject: string;
  body: string;
  refs: RefChip[];       // %D 解析结果
  /** Webview 侧 lanes.ts 填充 */
  lane?: number;
  row?: number;
}

export interface BranchInfo {
  name: string;          // short name，如 main / origin/main
  fullName: string;      // refs/heads/main
  sha: string;           // peeling 后的 commit sha
  upstream?: string;
  ahead?: number;
  behind?: number;
  isHead?: boolean;
  subject?: string;
  lastDate?: string;
  author?: string;
}

export interface RemoteGroup {
  name: string;          // remote 主机名，如 origin
  branches: BranchInfo[];
}

export interface TagInfo {
  name: string;
  sha: string;
  date?: string;
}

/** 提交列表筛选：ref（分支/远程/标签）+ 作者 + 时间段 */
export interface LogFilter {
  ref: string | null;
  author: string;
  since: string;    // YYYY-MM-DD 或空
  until: string;    // YYYY-MM-DD 或空
}

export interface RepoState {
  repoId: string;
  head: { sha: string; branch?: string; detached: boolean };
  branches: BranchInfo[];
  remotes: RemoteGroup[];
  tags: TagInfo[];
  status: { dirtyCount: number };
  filterRef: string | null;
  logFilter: { author: string; since: string; until: string };
  commits: Commit[];         // 已加载首页（后续经 commitsAppend 追加）
  commitsLoaded: number;
  hasMore: boolean;
  stateVersion: number;
}

export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T';

export interface FileChange {
  path: string;
  oldPath?: string;           // R 状态
  status: FileStatus;
  additions?: number;         // 二进制为 undefined
  deletions?: number;
}

export interface CommitDetail extends Commit {
  files: FileChange[];
  filesTruncated: boolean;
}

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  oldNo?: number;
  newNo?: number;
  text: string;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface UnifiedDiff {
  hunks: DiffHunk[];
  truncated: boolean;
}

export type DiffPayload =
  | { kind: 'diff'; diff: UnifiedDiff }
  | { kind: 'binary' }
  | { kind: 'tooLarge' }
  | { kind: 'empty' };
