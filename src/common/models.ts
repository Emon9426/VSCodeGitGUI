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
  seg?: number;          // 分支段 id（按分支着色，非 lane 槽位）
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

// ---------- 工作副本（Commit 功能，设计方案 v1.3） ----------

/** status --porcelain -z 单文件条目：XY 双列码派生出的暂存/未暂存矩阵 */
export interface FileEntry {
  path: string;
  origPath?: string;                                  // R 状态的原路径
  staged: 'M' | 'A' | 'D' | 'R' | null;               // X 列（index 相对 HEAD）
  unstaged: 'M' | 'D' | null;                         // Y 列（worktree 相对 index）
  untracked: boolean;                                 // '??'
  conflict?: boolean;                                 // UU/DD/AA/AU/UA/DU/UD 未解决冲突（独立分组）
  additions?: number;                                 // 对应侧 numstat（二进制 undefined）
  deletions?: number;
}

export interface WorkState {
  repoId: string;
  staged: FileEntry[];
  unstaged: FileEntry[];
  conflicts: FileEntry[];                             // 未解决冲突（ours/theirs 二选一解决）
  dirtyCount: number;
  merging: boolean;                                   // 存在未解决冲突路径
  mergeKind: 'merge' | 'other';                       // merge=正常合并（我的=本地）；other=rebase 等（ours/theirs 语义随场景）
  headShortSha: string;                               // 空状态 / amend 提示用
  headSubject: string;
  headDate: string;                                   // iso-strict
}

export interface CommitDraft {
  message: string;
  pushAfter: boolean;
  amend: boolean;
}

export interface AiModelInfo {
  id: string;
  name: string;
  family: string;
  isDefault: boolean;
}

export interface RecentMessage {
  subject: string;
  body: string;
}
