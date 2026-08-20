/**
 * Webview 通信协议 —— 两侧共享（设计方案第 8 节）。
 * 请求-响应：Webview 生成自增 id，扩展侧回 res 携带同 id。
 * 事件：扩展侧主动推送。
 */
import type { RepoMeta, RepoState, Commit, CommitDetail, DiffPayload, WorkState } from './models';

export interface ConfigDto {
  language: 'auto' | 'zh-CN' | 'en';
  dateFormat: 'datetime' | 'relative' | 'iso';
  rowHeightPx: number;            // 20 / 24 / 28
  graphStyle: 'curved' | 'angular';
  graphColumnWidth: number;       // 120–260
  maxTagChips: number;
  showRemoteChips: boolean;
  detailPanelPosition: 'bottom' | 'right';
  commitPageSize: number;
  maxAutoLoad: number;
  fetchOnOpen: boolean;
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
}

export type OpKind = 'fetch' | 'pull' | 'push' | 'reset' | 'checkout'
  | 'stage' | 'unstage' | 'discard' | 'discardClean' | 'commit'
  | 'resolveConflict' | 'commitNoEdit'
  | 'tagCreate' | 'tagDelete' | 'tagDeleteRemote' | 'tagPush';

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
  | { t: 'ready'; config: ConfigDto; repos: RepoMeta[]; language: string; colWidths?: ColWidths; selectedSha?: string; version?: string }
  | { t: 'repoState'; state: RepoState }
  | { t: 'commitsAppend'; repoId: string; offset: number; commits: Commit[]; hasMore: boolean }
  | OpProgress
  | OpResult
  | { t: 'notify'; level: 'info' | 'warn' | 'error'; message: string }
  | { t: 'configChanged'; config: ConfigDto; language: string }
  | { t: 'themeChanged' }
  // 工作副本（Commit 功能）
  | { t: 'workState'; state: WorkState }
  | { t: 'showWork' }
  | { t: 'aiChunk'; text: string }
  | { t: 'aiDone'; model: string; instructions: number }
  | { t: 'aiError'; code: 'noModel' | 'auth' | 'quota' | 'canceled' | 'error'; message?: string };

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
  | 'ui:openDiffEditor'     // { sha, path, base?, worktree? }
  | 'ui:revealInFM'         // { path }
  | 'ui:copy'               // { text }
  | 'ui:saveColWidths'      // { widths: ColWidths }
  | 'ui:openSettings'
  // 工作副本（Commit 功能）
  | 'work.state'            // {} -> WorkState
  | 'work.stage'            // { paths: string[] }
  | 'work.unstage'          // { paths: string[] }
  | 'work.resolveConflict'  // { paths: string[], ours: boolean }（冲突二选一；全解决自动完成合并）
  | 'tag.create'            // { name, sha?, message? }（message 非空=附注标签）
  | 'tag.delete'            // { name, remote? }（remote 存在=同时删远端）
  | 'tag.push'              // { name, remote? }
  | 'work.stageAll'         // {}
  | 'work.unstageAll'       // {}
  | 'work.discard'          // { paths: string[] }
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
  | 'ui:pickLanguage';       // {} → 宿主弹 QuickPick 三选一并写回 gitboard.language

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
