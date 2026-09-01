/** Webview 侧全局 UI 状态（唯一事实来源在扩展宿主，这里只是呈现缓存）。 */
import { createT, type Lang, type Translate } from '../common/i18n';
import type { AiModelInfo, Commit, CommitDetail, DiffPayload, FileHistoryItem, FileItem, PathChain, ProjectInfo, RecentMessage, RepoMeta, RepoState, WorkState } from '../common/models';
import type { ConfigDto } from '../common/protocol';
import type { GraphData } from '../graph/lanes';

/** main.ts 实现、各组件调用的应用接口 */
export interface App {
  selectRepo(repoId: string): void;
  setFilter(ref: string | null): void;
  /** 更新作者（多选）/时间段/纯提交筛选（与当前 ref 筛选合并后发送） */
  setLogFilter(f: { authors: string[]; since: string; until: string; noMerges?: boolean }): void;
  selectCommit(sha: string): void;
  loadMore(): void;
  runFetch(remote?: string): void;
  runPull(): void;
  runPush(): void;
  runRefresh(): void;
  cancelOp(opId: number): void;
  openSettings(): void;
  /** 直达快速笔记面板（v0.15.1，独立于 Git 的模块） */
  openNotes(): void;
  copy(text: string): void;
  openDiffEditor(sha: string, path: string, worktree?: boolean): void;
  openFile(path: string): void;
  openFileAt(sha: string, path: string): void;
  /** 批量在 VS Code 中打开工作区文件（详情面板多选；不存在文件由宿主跳过并回报） */
  openFiles(paths: string[]): void;
  revealInFM(path: string): void;
  checkoutRef(ref: string): void;
  checkoutRemoteAs(remoteBranch: string, suggest: string): void;
  checkoutDetached(sha: string): void;
  resetTo(sha: string): void;
  requestDiff(sha: string, path: string): void;
  /** 拉取当前仓库作者候选（缓存于 S.authors，仓库切换失效） */
  listAuthors(): Promise<string[]>;
  // 工作副本（Commit 功能）
  setView(view: 'graph' | 'pure' | 'work' | 'files'): void;
  /** 立即拉取最新文件修改状态（刷新按钮；编辑器改动不触发 .git 事件，需手动取） */
  requestWorkState(): void;
  workStage(paths: string[], stage: boolean): void;
  workStageAll(): void;
  workUnstageAll(): void;
  workDiscard(paths: string[]): void;
  deleteFile(paths: string[]): void;
  requestWorkDiff(path: string): void;
  workCommit(opts: { message: string; push?: boolean; amend?: boolean; all?: boolean }): Promise<{ ok: boolean; shortSha?: string; dirty?: number }>;
  workAmendLoad(): Promise<{ shortSha: string; message: string } | null>;
  workRecentMessages(): Promise<RecentMessage[]>;
  aiGenerate(modelId?: string): void;
  aiCancel(): void;
  saveDraft(draft: { message: string; pushAfter: boolean; amend: boolean }): void;
  openWorkDiffEditor(path: string): void;
  pickLanguage(): void;
  // 冲突解决（ours/theirs 二选一）
  resolveConflict(paths: string[], ours: boolean): void;
  // 合并解决器（v0.10）：语义侧操作（mine/theirs），扩展侧按 mergeKind 映射
  openMerge(path?: string): void;
  mergeResolve(path: string, sideTheirs: boolean): void;
  mergeAbort(): void;
  /** 横幅「完成合并」：确认后 commit --no-edit / rebase --continue */
  mergeFinishAsk(): void;
  // 标签
  tagCreate(name: string, sha?: string, message?: string): void;
  tagDelete(name: string, remote?: string): void;
  tagPush(name: string, remote?: string): void;
  // 工程切换（v0.11）
  projectAdd(path: string, name: string): void;
  projectRename(id: string, name: string): void;
  projectRemove(id: string): void;
  projectPickFolder(): Promise<string | null>;
  /** 双击/菜单打开工程：newWindow=false 当前窗口替换，true 新窗口 */
  projectOpen(id: string, newWindow: boolean): void;
  // 文件历史页（v0.14）
  /** 地址栏/面包屑导航到目录（拉取该目录直接子项）；opts.select=导航后选中定位（explorer 直达） */
  filesNavigate(dir: string, opts?: { select?: string }): void;
  /** 选中文件/目录 → 拉取历史（files.log / files.dirLog）联动右区 */
  filesSelect(path: string, isDir: boolean): void;
  /** 详情就地展开：该文件在此提交的变化 */
  filesCommitDiff(sha: string, path: string): void;
  /** 两版比对（blob 级，取 S.files.picked 两项） */
  filesVersionDiff(): void;
  /** 移动（多选批量；目标目录由宿主 showOpenDialog 选择） */
  folderMove(srcs: string[]): void;
  /** 重命名（promptDialog 输入新名 → 同目录 git mv） */
  folderRename(path: string): void;
  /** 删除（确认后：已跟踪 git rm / 未跟踪磁盘删除） */
  folderDelete(paths: string[]): void;
  /** 面板宽度与列宽持久化（拖拽松开时防抖调用） */
  saveFilesLayout(paneW: number, cols: number[] | undefined): void;
  /** 折叠/展开左侧栏（工程/仓库/分支/远程），状态跨会话保持 */
  toggleSide(): void;
}

export const S = {
  config: {
    language: 'auto', dateFormat: 'datetime', rowHeightPx: 24, graphStyle: 'github',
    graphColumnWidth: 180, maxTagChips: 2, showRemoteChips: true, detailPanelPosition: 'bottom',
    commitPageSize: 500, maxAutoLoad: 20000, fetchOnOpen: true, autoFetchInterval: 10, fetchPrune: true,
    defaultPullStrategy: 'merge', logOrder: 'topo', pullFetchSummary: true,
  } as ConfigDto,
  lang: 'zh-CN' as Lang,
  t: createT('zh-CN') as Translate,
  repos: [] as RepoMeta[],
  /** 仓库扫描进行中（v0.14.7）：ready 先行渲染，reposChanged 到达后置 false */
  reposPending: false,
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
  /** 作者（多选）/时间段/纯提交筛选（随 repoState 同步） */
  logFilter: { authors: [] as string[], since: '', until: '', noMerges: false } as { authors: string[]; since: string; until: string; noMerges: boolean },
  /** 作者多选下拉候选（listAuthors 按需拉取；repoId 变化即失效重取） */
  authors: [] as string[],
  authorsLoadedFor: undefined as string | undefined,
  /** 详情请求在途的提交 sha（面板置灰提示） */
  detailLoading: undefined as string | undefined,
  /** 详情面板高度百分比（vh；ready 时由扩展侧持久化值覆盖，跨屏按相对高度恢复） */
  detailPct: undefined as number | undefined,
  /** 侧栏折叠（工程/仓库/分支/远程向左收起；ready 时由扩展侧持久化值覆盖） */
  sideCollapsed: false,
  /** 进行中的操作（opId → 最近进度） */
  activeOps: new Map<number, { kind: string; text: string; pct?: number }>(),

  // ---------- 工程切换（v0.11） ----------
  projects: [] as ProjectInfo[],
  /** 当前工作区命中的工程（侧栏高亮） */
  activeProjectIds: [] as string[],
  /** 工作区根路径（「保存当前工作区」入口用） */
  workspaceFolders: [] as string[],

  // ---------- 文件历史页（v0.14） ----------
  files: {
    cwd: '',
    items: [] as FileItem[],
    lsLoading: false,
    view: 'det' as 'det' | 'tile',          // 详细信息（默认）| 文件夹（平铺）
    filter: '',
    sel: [] as string[],                     // 多选 path 列表（顺序即选择序）
    anchor: undefined as string | undefined, // Shift 范围锚点（无视觉标识，五审定稿）
    follow: true,                            // 跟随移动/重命名
    history: undefined as { items: FileHistoryItem[]; chain: PathChain } | undefined,
    histLoading: false,
    histFor: undefined as string | undefined, // 历史对应的 path+follow（防过期响应）
    histIsDir: false,                          // 选中对象是否目录（决定 log/dirLog 与图标）
    picked: [] as FileHistoryItem[],          // 比对勾选（≤ 2，第 3 个挤掉最早）
    detailSha: undefined as string | undefined, // 就地展开详情的提交
    detailDiff: undefined as DiffPayload | undefined,
    diff: undefined as DiffPayload | undefined, // 比对结果
    diffPair: undefined as { a: FileHistoryItem; b: FileHistoryItem } | undefined,
    paneW: 388,
    cols: undefined as number[] | undefined,   // 详细信息视图列宽（记忆）
    moveBanner: undefined as { srcs: string[]; dst: string; from: string } | undefined, // 移动完成引导横幅
  },

  // ---------- 工作副本（Commit 功能） ----------
  /** 当前主视图：graph 提交图 | pure 纯提交列表 | work 工作副本 | files 文件历史（display 切换，DOM 不销毁） */
  view: 'graph' as 'graph' | 'pure' | 'work' | 'files',
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
