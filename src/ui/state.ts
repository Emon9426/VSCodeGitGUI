/** Webview 侧全局 UI 状态（唯一事实来源在扩展宿主，这里只是呈现缓存）。 */
import { createT, type Lang, type Translate } from '../common/i18n';
import type { Commit, CommitDetail, DiffPayload, RepoMeta, RepoState } from '../common/models';
import type { ConfigDto } from '../common/protocol';
import type { GraphData } from '../graph/lanes';

/** main.ts 实现、各组件调用的应用接口 */
export interface App {
  selectRepo(repoId: string): void;
  setFilter(ref: string | null): void;
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
  repoId: undefined as string | undefined,
  state: undefined as RepoState | undefined,
  commits: [] as Commit[],
  graph: undefined as GraphData | undefined,
  selectedSha: undefined as string | undefined,
  detail: undefined as CommitDetail | undefined,
  selectedFile: undefined as string | undefined,
  diff: undefined as DiffPayload | undefined,
  /** 进行中的操作（opId → 最近进度） */
  activeOps: new Map<number, { kind: string; text: string; pct?: number }>(),

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
