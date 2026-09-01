/**
 * Webview 通信协议 —— 两侧共享（设计方案第 8 节）。
 * 请求-响应：Webview 生成自增 id，扩展侧回 res 携带同 id。
 * 事件：扩展侧主动推送。
 */
import type { ProjectInfo, PullSummaryEntry, PullFileStat, RepoMeta, RepoState, Commit, CommitDetail, DiffPayload, WorkState, MoveDetect } from './models';

export interface ConfigDto {
  language: 'auto' | 'zh-CN' | 'en';
  dateFormat: 'datetime' | 'relative' | 'iso';
  rowHeightPx: number;            // 20 / 24 / 28
  graphStyle: 'curved' | 'angular' | 'github';
  graphColumnWidth: number;       // 120–260
  maxTagChips: number;
  showRemoteChips: boolean;
  detailPanelPosition: 'bottom' | 'right';
  commitPageSize: number;
  maxAutoLoad: number;
  fetchOnOpen: boolean;
  /** 后台自动获取间隔（分钟，SourceTree 式；0=关闭）——仅面板存活期间执行 */
  autoFetchInterval: number;
  fetchPrune: boolean;
  defaultPullStrategy: 'merge' | 'rebase' | 'ff-only';
  logOrder: 'topo' | 'date';      // topo=走线规整（默认）；date=大仓库 log 更快
  // Commit 功能（v0.7）
  aiEnabled: boolean;
  aiLanguage: 'auto' | 'en' | 'zh-cn';
  aiLearnFromHistory: boolean;
  aiUseWorkspaceInstructions: boolean;
  commitClearMessage: boolean;
  commitPushAfter: boolean;
  startView: 'graph' | 'work' | 'last';
  /** Pull/Fetch 后弹窗显示拉到的纯净提交摘要（v0.13） */
  pullFetchSummary: boolean;
}

export type OpKind = 'fetch' | 'pull' | 'push' | 'reset' | 'checkout'
  | 'stage' | 'unstage' | 'discard' | 'discardClean' | 'commit'
  | 'resolveConflict' | 'commitNoEdit'
  | 'mergeAbort' | 'mergeContinue' | 'resolveDelete'
  | 'tagCreate' | 'tagDelete' | 'tagDeleteRemote' | 'tagPush'
  // 文件页操作（v0.14）：移动/重命名同为 git mv（重命名=同目录）；删除=git rm（未跟踪走 fs）
  | 'moveFolder' | 'renamePath' | 'deletePaths'
  | 'refresh';   // v0.9.2：refresh 纳入统一进度模型（无取消、秒级）

export interface OpProgress {
  t: 'opProgress';
  opId: number;
  kind: OpKind;
  text: string;       // 最近一行进度（已本地化前缀）
  pct?: number;       // 0–100
}

export interface OpResult {
  t: 'opResult';
  opId: number;
  kind: OpKind;
  ok: boolean;
  message?: string;
  outputTail?: string;   // 失败时的 stderr/stdout 尾部
}

/** 用户自定义列宽（持久化于 globalState，时间为自适应剩余列不持久化） */
export interface ColWidths {
  graph: number;
  msg: number;
  author: number;
  sha: number;
}

export type ExtEvent =
  | { t: 'ready'; config: ConfigDto; repos: RepoMeta[]; language: string; colWidths?: ColWidths; selectedSha?: string; version?: string;
      /** 仓库扫描进行中（v0.14.7）：ready 不再等待 git 探测，外壳先行渲染；repos 由随后的 reposChanged 补发 */
      reposPending?: boolean;
      /** 详情面板高度百分比（vh）：不同尺寸屏幕按相对高度恢复 */
      detailPct?: number;
      /** 文件页布局（v0.14）：左区面板宽度 px + 详细信息视图列宽 px 数组 */
      filesLayout?: { paneW: number; cols: number[] };
      /** 侧栏折叠状态（v0.14.1）：跨会话保持 */
      sideCollapsed?: boolean;
      /** 工作副本文件列表宽度 px：跨会话恢复 */
      workFilesW?: number;
      /** 已保存的工程列表 / 当前工作区命中的工程 / 工作区根路径（v0.11） */
      projects?: ProjectInfo[]; activeProjectIds?: string[]; workspaceFolders?: string[] }
  | { t: 'repoState'; state: RepoState }
  // 仓库扫描完成（v0.14.7）：ready(reposPending) 之后异步补发发现的仓库列表（空=无 git 仓库/未找到 git）
  | { t: 'reposChanged'; repos: RepoMeta[] }
  | { t: 'commitsAppend'; repoId: string; offset: number; commits: Commit[]; hasMore: boolean }
  | OpProgress
  | OpResult
  | { t: 'notify'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'configChanged'; config: ConfigDto; language: string }
  | { t: 'themeChanged' }
  | { t: 'projectsChanged'; projects: ProjectInfo[]; activeProjectIds: string[] }
  // 工作副本（Commit 功能）
  | { t: 'workState'; state: WorkState }
  | { t: 'showWork' }
  // Pull/Fetch 摘要（v0.13）：拉到的纯净提交（排除 merge），面板内弹窗呈现；
  // stat 为文件工作区现状（键=文件路径，重命名取新路径；仅含存在的文件）
  | { t: 'pullSummary'; repoId: string; kind: 'pull' | 'fetch'; entries: PullSummaryEntry[]; truncated: boolean; stat: Record<string, PullFileStat> }
  | { t: 'aiChunk'; text: string }
  | { t: 'aiDone'; model: string; instructions: number; fallback?: boolean }
  | { t: 'aiError'; code: 'noModel' | 'auth' | 'quota' | 'canceled' | 'error'; message?: string }
  // 文件历史页（v0.14）：explorer 右键「查看文件历史」→ 打开面板切文件视图并定位路径
  | { t: 'filesReveal'; path: string };

export interface WVRequest {
  id: number;
  cmd: string;
  args?: any;   // 各命令 payload 较小，用宽松类型换取两侧共享一个定义
}

export interface ExtResponse {
  t: 'res';
  id: number;
  ok: boolean;
  data?: any;
  error?: string;
}

export type Bootstrap = { t: 'bootstrap' };

/** Webview → 扩展 的全部命令名（含参数示意，路由见 panel.ts） */
export type WVCommand =
  | 'selectRepo'            // { repoId }
  | 'refresh'
  | 'loadMore'              // { offset }
  | 'commitDetail'          // { sha } -> CommitDetail
  | 'diff'                  // { mode:'commit'|'worktree'|'range', sha, base?, path } -> DiffPayload
  | 'setFilter'             // { ref: string | null }
  | 'op:fetch'              // { remote?: string, all?: boolean }
  | 'op:pull'               // { remote?, branch?, strategy?, autostash? }
  | 'op:push'               // { remote, branch, setUpstream? }
  | 'op:reset'              // { sha, mode:'soft'|'mixed'|'hard' }
  | 'op:checkout'           // { ref?, sha?, detached?, trackFrom?: {name, remoteBranch} }
  | 'op:cancel'             // { opId }
  | 'ui:openFile'           // { path }
  | 'ui:openFileAt'         // { sha, path }
  | 'ui:openFiles'          // { paths: string[] } -> { opened, missing }（详情面板多选批量打开）
  | 'ui:openDiffEditor'     // { sha, path, base?, worktree? }
  | 'ui:revealInFM'         // { path }
  | 'ui:copy'               // { text }
  | 'ui:saveColWidths'      // { widths: ColWidths }
  | 'ui:saveDetailPct'      // { pct }（详情面板高度百分比，跨屏按相对高度恢复）
  | 'ui:openSettings'
  // 快速笔记（v0.15.1）：主面板工具栏直达笔记面板
  | 'ui:openNotes'
  // 工作副本（Commit 功能）
  | 'work.state'            // {} -> WorkState
  | 'work.stage'            // { paths: string[] }
  | 'work.unstage'          // { paths: string[] }
  | 'work.resolveConflict'  // { paths: string[], ours: boolean }（git 级 ours/theirs；语义侧请用 merge.resolve）
  // 合并解决器（v0.10）
  | 'merge.session'         // { path } -> MergeSessionAny（文本/二进制/超限三态）
  | 'merge.resolve'         // { path, side: 'mine'|'theirs' }（语义侧二选一，扩展侧按 mergeKind 映射 --ours/--theirs）
  | 'merge.save'            // { path, content }（以合并后为准：原子写回 + add）
  | 'merge.deleteAccept'    // { path, side: 'mine'|'theirs' }（一方删除场景：保留现存侧 / 采纳删除）
  | 'merge.finish'          // {}（完成合并：merge→commit --no-edit；rebase→rebase --continue）
  | 'merge.abort'           // {}（merge --abort / rebase --abort 按 mergeKind）
  | 'merge.previewBinary'   // { path, side }（写临时文件后用系统程序打开预览）
  | 'tag.create'            // { name, sha?, message? }（message 非空=附注标签）
  | 'tag.delete'            // { name, remote? }（remote 存在=同时删远端）
  | 'tag.push'              // { name, remote? }
  | 'work.stageAll'         // {}
  | 'work.unstageAll'       // {}
  | 'work.discard'          // { paths: string[] }
  | 'work.deleteFile'       // { paths: string[] }（从磁盘删除；已跟踪文件删除后转未暂存 D，需暂存生效）
  | 'work.diff'             // { path } -> DiffPayload（HEAD↔工作副本；未跟踪=全新增）
  | 'work.commit'           // { message, push?, amend?, all? }
  | 'work.recentMessages'   // {} -> RecentMessage[]
  | 'work.amendLoad'        // {} -> { shortSha, message }
  | 'work.aiModels'         // {} -> AiModelInfo[]
  | 'work.aiGenerate'       // { modelId? }
  | 'work.aiCancel'         // {}
  | 'work.saveDraft'        // { draft: CommitDraft }
  | 'work.loadDraft'        // {} -> CommitDraft | null
  | 'work.saveLayout'        // { filesW, barH }
  | 'ui:setView'             // { view: 'graph' | 'work' } —— 记忆上次视图（startView=last）
  | 'ui:pickLanguage'        // {} → 宿主弹 QuickPick 三选一并写回 gitboard.language
  // 工程切换（v0.11）
  | 'projects.add'           // { path, name }（同路径重复添加 = 重命名）→ 推 projectsChanged
  | 'projects.rename'        // { id, name }
  | 'projects.remove'        // { id }
  | 'projects.pickFolder'    // {} -> { path } | null（系统文件夹选择对话框）
  | 'projects.open'          // { id, newWindow }（vscode.openFolder：当前窗口替换 / 新窗口）
  // 文件历史页（v0.14）；只读版本标签页复用 ui:openFileAt
  | 'files.ls'              // { dir } -> FileItem[]（目录直接子项：HEAD 快照 + 工作区 stat）
  | 'files.log'             // { path, follow } -> { items: FileHistoryItem[], chain: PathChain }（--follow 单命令）
  | 'files.dirLog'          // { dir, follow } -> { items, chain }（目录级：链反查 + 多 pathspec）
  | 'files.commitDiff'      // { sha, path } -> DiffPayload（详情展开：该文件此提交的变化）
  | 'files.versionDiff'     // { a:{sha,path}, b:{sha,path} } -> DiffPayload（blob 级两版比对，跨移动有效）
  | 'folder.move'           // { srcs: string[], dst }（多选批量 git mv；成功后引导纯移动提交）
  | 'folder.rename'         // { path, newName }（同目录 git mv）
  | 'folder.delete'         // { paths: string[] }（已跟踪 git rm / 未跟踪磁盘删除）
  | 'ui:saveFilesLayout'    // { paneW, cols }（面板宽度与列宽持久化）
  | 'ui:saveSideCollapsed'; // { collapsed }（侧栏折叠状态持久化，v0.14.1）

export interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

export const isExtEvent = (m: any): m is ExtEvent =>
  !!m && typeof m === 'object' && typeof m.t === 'string';

export const isWVRequest = (m: any): m is WVRequest =>
  !!m && typeof m === 'object'
  && (m.t === 'bootstrap' || (typeof m.id === 'number' && typeof m.cmd === 'string'));

/** 命令响应中可能携带的结构（守卫只做最小校验，供扩展侧防御用） */
export const isCommitDetail = (d: any): d is CommitDetail =>
  !!d && typeof d.sha === 'string' && Array.isArray(d.files);

export const isDiffPayload = (d: any): d is DiffPayload =>
  !!d && typeof d.kind === 'string';

export const isRepoState = (s: any): s is RepoState =>
  !!s && typeof s.repoId === 'string' && Array.isArray(s.commits);
