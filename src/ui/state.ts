/** Webview 侧全局 UI 状态（唯一事实来源在扩展宿主，这里只是呈现缓存）。 */
import { createT, type Lang, type Translate } from '../common/i18n';
import type { AiModelInfo, Commit, CommitDetail, DiffPayload, RecentMessage, RepoMeta, RepoState, WorkState } from '../common/models';
import type { ConfigDto } from '../common/protocol';
import type { GraphData } from '../graph/lanes';

/** main.ts 实现、各组件调用的应用接口 */
export interface App {
  selectRepo(repoId: string): void;
  setFilter(ref: string | null): void;
  /** 更新作者/时间段筛选（与当前 ref 筛选合并后发送） */
  setLogFilter(f: { author: string; since: string; until: string }): void;
  selectCommit(sha: string): void;
  loadMore(): void;
  runFetch(remote?: string): void;
  runPull(): void;
  runPush(): void;
  runRefresh(): void;
  cancelOp(opId: number): void;
  openSettings(): void;
  copy(text: string): void;
  openDiffEditor(sha: string, path: string, worktree?: boolean): void;
  openFile(path: string): void;
  openFileAt(sha: string, path: string): void;
  revealInFM(path: string): void;
  checkoutRef(ref: string): void;
  checkoutRemoteAs(remoteBranch: string, suggest: string): void;
  checkoutDetached(sha: string): void;
  resetTo(sha: string): void;
  requestDiff(sha: string, path: string): void;
  // 工作副本（Commit 功能）
  setView(view: 'graph' | 'work'): void;
  workStage(paths: string[], stage: boolean): void;
  workStageAll(): void;
  workUnstageAll(): void;
  workDiscard(paths: string[]): void;
  requestWorkDiff(path: string): void;
  workCommit(opts: { message: string; push?: boolean; amend?: boolean; all?: boolean }): Promise<{ ok: boolean; shortSha?: string }>;
  workAmendLoad(): Promise<{ shortSha: string; message: string } | null>;
  workRecentMessages(): Promise<RecentMessage[]>;
  aiGenerate(modelId?: string): void;
  aiCancel(): void;
  saveDraft(draft: { message: string; pushAfter: boolean; amend: boolean }): void;
  openWorkDiffEditor(path: string): void;
}

export const S = {
  config: {
    language: 'auto', dateFormat: 'datetime', rowHeightPx: 24, graphStyle: 'curved',
    graphColumnWidth: 180, maxTagChips: 2, showRemoteChips: true, detailPanelPosition: 'bottom',
    commitPageSize: 500, maxAutoLoad: 20000, fetchOnOpen: true, fetchPrune: true,
    defaultPullStrategy: 'merge',
  } as ConfigDto,
  lang: 'zh-CN' as Lang,
  t: createT('zh-CN') as Translate,
  repos: [] as RepoMeta[],
  version: '',   // 扩展版本（工具栏显示，便于确认当前构建）
  repoId: undefined as string | undefined,
  state: undefined as RepoState | undefined,
  commits: [] as Commit[],
  graph: undefined as GraphData | undefined,
  selectedSha: undefined as string | undefined,
  detail: undefined as CommitDetail | undefined,
  selectedFile: undefined as string | undefined,
  diff: undefined as DiffPayload | undefined,
  /** 列宽（图形/说明/作者/SHA，时间列自适应剩余空间）；ready 时由扩展侧持久化值覆盖 */
  colWidths: { graph: 150, msg: 460, author: 120, sha: 90 } as Record<'graph' | 'msg' | 'author' | 'sha', number>,
  /** 作者/时间段筛选（随 repoState 同步） */
  logFilter: { author: '', since: '', until: '' } as { author: string; since: string; until: string },
  /** 详情请求在途的提交 sha（面板置灰提示） */
  detailLoading: undefined as string | undefined,
  /** 进行中的操作（opId → 最近进度） */
  activeOps: new Map<number, { kind: string; text: string; pct?: number }>(),

  // ---------- 工作副本（Commit 功能） ----------
  /** 当前主视图：graph 提交图 | work 工作副本（display 切换，DOM 不销毁） */
  view: 'graph' as 'graph' | 'work',
  work: {
    state: undefined as WorkState | undefined,
    /** 选中行：path + 所在分组（决定 optimistic 勾选语义） */
    selectedPath: undefined as string | undefined,
    selectedStaged: false,
    diff: undefined as DiffPayload | undefined,
    diffLoading: undefined as string | undefined,
    filter: '',
    /** AI 状态机 */
    aiBusy: false,
    aiText: '',
    aiModels: [] as AiModelInfo[],
    aiModelId: undefined as string | undefined,
    aiMeta: undefined as string | undefined,
    /** 信息草稿（防抖持久化到宿主 globalState） */
    message: '',
    pushAfter: false,
    amend: false,
    amendSha: '',
  },

  resetList(): void {
    this.commits = [];
    this.graph = undefined;
    this.selectedSha = undefined;
    this.detail = undefined;
    this.selectedFile = undefined;
    this.diff = undefined;
  },
};

export type UiState = typeof S;
