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

/** 提交列表筛选：ref（分支/远程/标签）+ 作者多选 + 时间段 + 纯提交（隐藏合并提交） */
export interface LogFilter {
  ref: string | null;
  authors: string[];
  since: string;    // YYYY-MM-DD 或空
  until: string;    // YYYY-MM-DD 或空
  /** 纯提交视图：--no-merges 且按日期序（合并提交不出现，原始提交各显示一次） */
  noMerges: boolean;
}

export interface RepoState {
  repoId: string;
  head: { sha: string; branch?: string; detached: boolean };
  branches: BranchInfo[];
  remotes: RemoteGroup[];
  tags: TagInfo[];
  status: { dirtyCount: number };
  filterRef: string | null;
  logFilter: { authors: string[]; since: string; until: string; noMerges: boolean };
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
  conflictCode?: string;                              // XY 原码（UU/AA=双侧有内容；DU=我删他改；UD=我改他删；DD=双删；AU/UA=一方新增）
  additions?: number;                                 // 对应侧 numstat（二进制 undefined）
  deletions?: number;
}

export interface WorkState {
  repoId: string;
  staged: FileEntry[];
  unstaged: FileEntry[];
  conflicts: FileEntry[];                             // 未解决冲突（合并器/二选一解决）
  dirtyCount: number;
  merging: boolean;                                   // 存在未解决冲突路径
  /** 合并/变基会话类型：merge=普通合并（我=:2）；rebase=变基（我=:3，ours/theirs 反转）；other=cherry-pick 等 */
  mergeKind: 'merge' | 'rebase' | 'other';
  /** 合并/变基进行中（MERGE_HEAD / rebase 目录存在），conflicts 已清但未完成提交时为 true（"待完成合并"状态） */
  mergeActive: boolean;
  headShortSha: string;                               // 空状态 / amend 提示用
  headSubject: string;
  headDate: string;                                   // iso-strict
  /** 手动移动检测（v0.14）：未暂存"同前缀批量删除 + 同名未跟踪"配对（无移动时 undefined） */
  moveDetect?: MoveDetect;
}

// ---------- 合并解决器（设计方案 v1.3 §5.1） ----------

/** 语义参照标签（扩展侧给出原始 ref 名，UI 前缀文案自行 i18n） */
export interface MergeLabels {
  mineRef: string;      // 如 ''（merge=本地 HEAD）/ 'HEAD'
  theirsRef: string;    // 如 'feature-x'（MERGE_MSG 提取）/ 短 sha
}

/** 文本冲突会话：三栏数据（我的/他人/含标记的工作副本内容，前端解析为冲突块） */
export interface MergeSession {
  path: string;
  kind: 'merge' | 'rebase' | 'other';
  labels: MergeLabels;
  binary: false;
  base?: string;        // :1 原始内容（AI 输入用；一侧新增等场景缺省）
  mine: string;         // 语义"我的"完整内容
  theirs: string;       // 语义"他人"完整内容
  result: string;       // 工作副本当前内容（含冲突标记）
  /** 一侧为删除（DU/UD/DD）：被删侧内容为空串；UI 显示"保留现存版本/采纳删除" */
  deletedSide?: 'mine' | 'theirs';
  /** 完成合并确认框预览的默认合并信息（MERGE_MSG 首段） */
  mergeMsg?: string;
}

/** 二进制冲突会话：只提供二选一 + 系统程序预览 */
export interface MergeSessionBinary {
  path: string;
  kind: 'merge' | 'rebase' | 'other';
  labels: MergeLabels;
  binary: true;
  deletedSide?: 'mine' | 'theirs';
  mineSize?: number;    // 字节数（现存侧；被删侧 undefined）
  theirsSize?: number;
}

/** 超限会话：显式警告 + 降级为文件级三选一（决议 #5） */
export interface MergeSessionTooLarge {
  path: string;
  binary: false;
  tooLarge: true;
  lines: number;
  bytes: number;
}

export type MergeSessionAny = MergeSession | MergeSessionBinary | MergeSessionTooLarge;

/** 合并编辑器上限（决议 #5：16000 行 / 2 MB） */
export const MERGE_MAX_LINES = 16000;
export const MERGE_MAX_BYTES = 2 * 1024 * 1024;

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

// ---------- Pull/Fetch 摘要（v0.13） ----------

/** 拉到的纯净提交（排除 merge）：谁 · 哪个提交 · 改了哪些文件 */
export interface PullSummaryEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;            // iso-strict
  subject: string;
  files: string[];         // 变更文件（R/C 状态为 "旧路径 → 新路径"）
  filesTruncated: boolean; // 单提交文件数超上限截断
}

/** name-status R/C 重命名/复制的展示分隔（"旧路径 → 新路径"；宿主/UI 共用） */
export const RENAME_SEP = ' → ';

/** 摘要文件的工作区现状（宿主 fs.stat 只读采集；不在工作区的文件不产生条目） */
export interface PullFileStat {
  size: number;   // 字节
  mtime: string;  // ISO 时间戳
}

// ---------- 工程切换（v0.11） ----------

/** 用户保存的工程：跨工作区快速切换目标（持久化于 globalState） */
export interface ProjectInfo {
  id: string;      // root 路径 hash(8)（与 repoIdOf 同源）
  name: string;    // 自定义名称
  path: string;    // 绝对路径
}

// ---------- 文件历史页（v0.14） ----------

/** 目录直接子项（files.ls）：详细信息视图四列数据源（HEAD 快照 + 工作区 stat） */
export interface FileItem {
  name: string;
  path: string;          // 仓库相对路径
  isDir: boolean;
  size?: number;         // 字节（工作区存在时来自 fs.stat）
  mtime?: string;        // ISO（工作区 stat；不在工作区为 undefined → 显示 —）
  gitSize?: number;      // HEAD blob 大小（ls-tree -l；工作区未提交的新文件无）
  count?: number;        // 目录直接子项数
}

/** 文件历史条目：`log --follow --name-status` 单命令输出（path = 该提交时刻的路径） */
export interface FileHistoryItem {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;          // iso-strict
  path: string;          // 当时路径（R 行取新路径）
  status: 'A' | 'M' | 'R';
  oldPath?: string;      // R：变更前路径
  eraPrefix?: string;    // 非当前路径时期的"当时路径"（UI 时期徽标；当前段 undefined）
  milestone?: boolean;   // 移动/重命名提交（文件级=R 行；目录级=链段 endSha）
}

/** 路径链（跟随移动/重命名）：segments 从新到旧；endSha = 该段最早的提交（即把对象移出该段的移动提交，其本身属于更新的段） */
export interface PathChain {
  segments: { prefix: string; endSha?: string }[];
  partial?: boolean;     // 链构建提前终止（覆盖率不足 / 移动+修改混提交）
}

/** 手动移动检测（workState 派生）：同前缀批量删除 + 同名未跟踪配对 */
export interface MoveDetect {
  from: string;          // 旧目录前缀（'' = 仓库根）
  to: string;            // 新目录前缀
  count: number;
  paths: string[];       // 全部相关条目（删除侧 + 未跟踪侧，供"按移动提交"stage）
}
