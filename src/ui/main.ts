/**
 * Webview 入口：装配各组件、处理扩展宿主事件与请求（设计方案 8 节协议）。
 */
import './styles/main.css';
import { computeLanes } from '../graph/lanes';
import { createT, type Lang } from '../common/i18n';
import type { ExtEvent } from '../common/protocol';
import { handleResponse, postRaw, rpc } from './rpc';
import { S, type App } from './state';
import { el } from './util';
import { createCommitList } from './app/commitList';
import { createDetailPanel } from './app/detailPanel';
import { createSidebar } from './app/sidebar';
import { createToolbar } from './app/toolbar';
import { createWorkView } from './app/workView';
import { createCommitBar } from './app/commitBar';
import { confirmDialog, promptDialog, resetDialog, toast } from './app/overlays';

// ---------- App 实现 ----------

const app: App = {
  selectRepo(repoId) {
    if (S.repoId !== repoId) {
      S.repoId = repoId;
      S.state = undefined;
      S.resetList();
      sidebar.update();
      toolbar.update();
      detail.update();
    }
    void rpc('selectRepo', { repoId }).catch(showErr);
  },
  setFilter(ref) {
    if (S.state) S.state.filterRef = ref;
    void rpc('setFilter', { ref, ...S.logFilter }).catch(showErr);
  },
  setLogFilter(f) {
    const DATE = /^\d{4}-\d{2}-\d{2}$/;
    S.logFilter = {
      author: f.author.trim().slice(0, 200),
      since: DATE.test(f.since) ? f.since : '',
      until: DATE.test(f.until) ? f.until : '',
    };
    void rpc('setFilter', { ref: S.state?.filterRef ?? null, ...S.logFilter }).catch(showErr);
  },
  selectCommit(sha) {
    S.selectedSha = sha;
    S.detailLoading = sha;
    list.selectionChanged();
    detail.update();
    void rpc('commitDetail', { sha })
      .then(d => {
        if (S.selectedSha !== sha) return;   // 已切换到其他提交，丢弃过期响应
        S.detailLoading = undefined;
        S.detail = d;
        S.selectedFile = undefined;
        S.diff = undefined;
        detail.update();
      })
      .catch(e => {
        if (S.selectedSha === sha) {
          S.detailLoading = undefined;
          detail.update();
        }
        showErr(e);
      });
  },
  loadMore() {
    // 记录发起时的列表尾锚点：commitsAppend 到达时校验列表未被 repoState 重排（防新旧快照混拼出缺口）
    pendingLoad = { repoId: S.repoId, offset: S.commits.length, anchor: S.commits[S.commits.length - 1]?.sha };
    void rpc('loadMore', { offset: pendingLoad.offset })
      .then(r => { if (!r) list.refresh(); })   // 页被宿主丢弃（refs 漂移）：复位加载状态，等 repoState 重建
      .catch(e => { showErr(e); list.refresh(); });
  },
  runFetch(remote) {
    void rpc('op:fetch', remote ? { all: false, remote } : { all: true, prune: S.config.fetchPrune }).catch(showErr);
  },
  runPull() {
    const head = S.state?.branches.find(b => b.isHead);
    if (!head?.upstream) {
      toast('warn', S.t('pullNoUpstream'));
      return;
    }
    const remote = head.upstream.split('/')[0];
    void rpc('op:pull', { remote, branch: S.state?.head.branch, strategy: S.config.defaultPullStrategy }).catch(showErr);
  },
  runPush() {
    const head = S.state?.branches.find(b => b.isHead);
    const branch = S.state?.head.branch;
    if (!head?.upstream) {
      void confirmDialog(S.t('push'), S.t('pushNoUpstream'), S.t('yes')).then(ok => {
        if (!ok) return;
        const remote = S.state?.remotes[0]?.name ?? 'origin';
        void rpc('op:push', { remote, branch, setUpstream: true }).catch(showErr);
      });
      return;
    }
    void rpc('op:push', { remote: head.upstream.split('/')[0], branch }).catch(showErr);
  },
  runRefresh() {
    toolbar.setRefreshBusy(true);
    void rpc('refresh')
      .then(() => toast('info', S.t('refreshDone')))
      .catch(showErr)
      .finally(() => toolbar.setRefreshBusy(false));
  },
  cancelOp(opId) {
    void rpc('op:cancel', { opId }).catch(showErr);
  },
  openSettings() {
    void rpc('ui:openSettings').catch(showErr);
  },
  copy(text) {
    void rpc('ui:copy', { text }).catch(showErr);
  },
  openDiffEditor(sha, path, worktree) {
    void rpc('ui:openDiffEditor', { sha, path, worktree: !!worktree }).catch(showErr);
  },
  openFile(path) {
    void rpc('ui:openFile', { path }).catch(showErr);
  },
  openFileAt(sha, path) {
    void rpc('ui:openFileAt', { sha, path }).catch(showErr);
  },
  revealInFM(path) {
    void rpc('ui:revealInFM', { path }).catch(showErr);
  },
  checkoutRef(ref) {
    void rpc('op:checkout', { ref }).catch(showErr);
  },
  checkoutRemoteAs(remoteBranch, suggest) {
    void promptDialog(S.t('checkoutAs'), S.t('branchNameLabel'), suggest).then(name => {
      if (name) void rpc('op:checkout', { trackFrom: { name, remoteBranch } }).catch(showErr);
    });
  },
  checkoutDetached(sha) {
    void confirmDialog(S.t('checkoutDetached'), sha.slice(0, 12), S.t('yes')).then(ok => {
      if (ok) void rpc('op:checkout', { sha, detached: true }).catch(showErr);
    });
  },
  resetTo(sha) {
    void resetDialog(sha, S.state?.status.dirtyCount ?? 0, S.t).then(mode => {
      if (mode) void rpc('op:reset', { sha, mode }).catch(showErr);
    });
  },
  requestDiff(sha, path) {
    void rpc('diff', { mode: 'commit', sha, path })
      .then(p => {
        if (S.selectedFile === path && S.detail?.sha === sha) {
          S.diff = p;
          detail.update();
        }
      })
      .catch(showErr);
  },
  // ---------- 工作副本（Commit 功能） ----------
  setView(view) {
    if (S.view === view) return;
    S.view = view;
    void rpc('ui:setView', { view }).catch(() => undefined);
    applyView();
    if (view === 'work') {
      void rpc('work.state').catch(showErr);
      loadDraftOnce();
      refreshAiModels();   // Copilot 登录状态可能变化，进出视图时刷新
    }
  },
  workStage(paths, stage) {
    void rpc(stage ? 'work.stage' : 'work.unstage', { paths }).catch(showErr);
  },
  workStageAll() {
    void rpc('work.stageAll').catch(showErr);
  },
  workUnstageAll() {
    void rpc('work.unstageAll').catch(showErr);
  },
  workDiscard(paths) {
    void rpc('work.discard', { paths }).catch(showErr);
  },
  requestWorkDiff(path) {
    S.work.diffLoading = path;
    workview.updateDiff();
    void rpc('work.diff', { path })
      .then(p => {
        if (S.work.selectedPath !== path) return;   // 已切换文件，丢弃过期响应
        S.work.diffLoading = undefined;
        S.work.diff = p;
        workview.updateDiff();
      })
      .catch(e => {
        if (S.work.selectedPath === path) {
          S.work.diffLoading = undefined;
          workview.updateDiff();
        }
        showErr(e);
      });
  },
  workCommit(opts) {
    return rpc('work.commit', { message: opts.message, push: opts.push, amend: opts.amend, all: opts.all });
  },
  workAmendLoad() {
    return rpc('work.amendLoad');
  },
  workRecentMessages() {
    return rpc('work.recentMessages');
  },
  aiGenerate(modelId) {
    // 长流式请求：结果经 aiChunk/aiDone/aiError 事件驱动 UI；RPC 超时（>120s）不算错误
    void rpc('work.aiGenerate', modelId ? { modelId } : {})
      .catch(e => { if (!/timeout/i.test(String((e as Error)?.message))) showErr(e); });
  },
  aiCancel() {
    void rpc('work.aiCancel').catch(() => undefined);
  },
  saveDraft(draft) {
    void rpc('work.saveDraft', { draft }).catch(() => undefined);
  },
  pickLanguage() {
    void rpc('ui:pickLanguage').catch(showErr);
  },
  openWorkDiffEditor(path) {
    // 已删除文件（工作区已不存在）无法作为右侧打开
    const entry = [...(S.work.state?.staged ?? []), ...(S.work.state?.unstaged ?? [])].find(e => e.path === path);
    if (entry && !entry.untracked && !entry.staged && entry.unstaged === 'D') {
      toast('warn', S.t('workDeletedFile'));
      return;
    }
    void rpc('ui:openDiffEditor', { sha: 'HEAD', base: 'HEAD', path, worktree: true }).catch(showErr);
  },
  // 冲突二选一（ours=我的/本地，merge 语义）
  resolveConflict(paths, ours) {
    void rpc('work.resolveConflict', { paths, ours }).catch(showErr);
  },
  // 标签：创建成功后 toast 询问是否推送
  tagCreate(name, sha, message) {
    void rpc('tag.create', { name, sha, message })
      .then(() => {
        toast('info', S.t('tagCreated', { name }), {
          label: S.t('pushTagTo', { remote: 'origin' }),
          run: () => app.tagPush(name),
        });
      })
      .catch(showErr);
  },
  tagDelete(name, remote) {
    void rpc('tag.delete', { name, remote }).catch(showErr);
  },
  tagPush(name, remote) {
    void rpc('tag.push', { name, remote }).catch(showErr);
  },
};

function showErr(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  toast('error', msg);
}

// ---------- 布局 ----------

const toolbar = createToolbar(app);
const sidebar = createSidebar(app);
const list = createCommitList(app);
const detail = createDetailPanel(app);
const workview = createWorkView(app);
const commitBar = createCommitBar(app);

const mainEl = el('div', 'gg-main');
const workWrap = el('div', 'gg-work-wrap hidden');
workWrap.append(workview.el, commitBar.el);
mainEl.append(list.el, detail.el, workWrap);
const bodyEl = el('div', 'gg-body');
bodyEl.append(sidebar.el, mainEl);
const host = document.getElementById('app');
if (host) {
  host.append(toolbar.el, bodyEl);
} else {
  document.body.append(toolbar.el, bodyEl);
}

function applyLayout(): void {
  mainEl.classList.toggle('detail-right', S.config.detailPanelPosition === 'right');
}

/** 视图切换：display 切换不销毁 DOM（草稿/滚动/选中全部保留） */
function applyView(): void {
  const work = S.view === 'work';
  bodyEl.classList.toggle('work-mode', work);
  list.el.classList.toggle('hidden', work);
  detail.el.classList.toggle('hidden', work);
  workWrap.classList.toggle('hidden', !work);
  toolbar.update();
}

/** 每仓库只恢复一次草稿；此后由输入侧防抖保存 */
let draftLoadedFor: string | undefined;
function loadDraftOnce(): void {
  if (draftLoadedFor === S.repoId) return;
  draftLoadedFor = S.repoId;
  void rpc('work.loadDraft')
    .then(d => {
      if (d && S.repoId) commitBar.applyDraft(d);
      else commitBar.update();
    })
    .catch(() => undefined);
}

/** AI 模型列表（Copilot 可用时填充下拉） */
function refreshAiModels(): void {
  if (!S.config.aiEnabled) { S.work.aiModels = []; commitBar.update(); return; }
  void rpc('work.aiModels')
    .then(models => { S.work.aiModels = models ?? []; commitBar.update(); })
    .catch(() => undefined);
}

// Esc 停止 AI 生成
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && S.work.aiBusy) app.aiCancel();
});
applyLayout();

/** 原生日期选择器等控件跟随 VS Code 明暗主题 */
function applyThemeKind(): void {
  const kind = getComputedStyle(document.body).getPropertyValue('--vscode-theme-kind');
  document.body.style.colorScheme = kind.includes('dark') ? 'dark' : 'light';
}

let restoreSha: string | undefined;   // Webview 重建后恢复选中的提交
/** 在途分页请求锚点：repoId + offset + 发起时的列表尾 sha，三者与当前列表一致才允许拼接 */
let pendingLoad: { repoId: string | undefined; offset: number; anchor: string | undefined } | undefined;

function applyColWidths(w: { graph?: number; msg?: number; author?: number; sha?: number }): void {
  for (const key of ['graph', 'msg', 'author', 'sha'] as const) {
    const v = w[key];
    if (typeof v === 'number' && v >= 40) S.colWidths[key] = Math.round(v);
  }
}

// ---------- 事件处理 ----------

window.addEventListener('message', e => {
  const m = e.data as ExtEvent;
  if (!m || typeof m !== 'object') return;
  if ((m as any).t === 'res') { handleResponse(m as any); return; }
  switch (m.t) {
    case 'ready':
      S.config = m.config;
      S.lang = (m.language === 'en' ? 'en' : 'zh-CN') as Lang;
      S.t = createT(S.lang);
      S.repos = m.repos;
      S.version = m.version ?? '';
      if (m.colWidths) applyColWidths(m.colWidths);
      restoreSha = m.selectedSha;
      applyThemeKind();
      list.configChanged();
      toolbar.update();
      sidebar.update();
      detail.update();
      applyLayout();
      applyView();
      refreshAiModels();
      break;
    case 'repoState': {
      const st = m.state;
      const repoChanged = st.repoId !== S.repoId;
      if (repoChanged) {
        S.repoId = st.repoId;
        S.selectedSha = undefined;
        S.detail = undefined;
        S.diff = undefined;
        S.selectedFile = undefined;
        // 工作副本：换仓库 → 选中/diff 失效，草稿待重载
        S.work.state = undefined;
        S.work.selectedPath = undefined;
        S.work.diff = undefined;
        draftLoadedFor = undefined;
      } else if (S.selectedSha && !st.commits.some(c => c.sha === S.selectedSha)) {
        S.selectedSha = undefined;
        S.detail = undefined;
        S.diff = undefined;
        S.selectedFile = undefined;
      }
      S.state = st;
      S.commits = st.commits;
      S.graph = computeLanes(st.commits);
      // 列表已整体重建：作废在途分页请求（其页属旧快照，拼接必错位）
      pendingLoad = undefined;
      if (st.logFilter) S.logFilter = st.logFilter;
      if (repoChanged) list.reset(); else list.refresh();
      sidebar.update();
      toolbar.update();
      toolbar.syncFilterInputs(S.logFilter);
      detail.update();
      // 刷新后选中仍在但详情缺失（如请求曾被刷新打断）：自动补拉
      if (S.selectedSha && !S.detailLoading && S.detail?.sha !== S.selectedSha) {
        app.selectCommit(S.selectedSha);
      } else if (restoreSha && S.commits.some(c => c.sha === restoreSha)) {
        // Webview 重建后的选中恢复
        const sha = restoreSha;
        restoreSha = undefined;
        app.selectCommit(sha);
      } else if (restoreSha) {
        restoreSha = undefined;
      }
      break;
    }
    case 'commitsAppend': {
      if (m.repoId !== S.repoId) { list.refresh(); break; }
      // 锚点校验：offset/计数/尾 sha 均未变 ⇒ 列表自请求发起以来未被 repoState 重置，
      // 本页与列表同属一个 refs 快照，可安全拼接；失配则丢弃（错位拼接会产生缺口/重复），
      // 复位加载状态后滚动到底会以新 offset 自动重发
      const anchored = !!pendingLoad
        && pendingLoad.repoId === m.repoId
        && pendingLoad.offset === m.offset
        && pendingLoad.offset === S.commits.length
        && pendingLoad.anchor === S.commits[S.commits.length - 1]?.sha;
      pendingLoad = undefined;
      if (anchored) {
        if (m.commits.length) {
          S.commits.push(...m.commits);
          S.graph = computeLanes(S.commits);
        }
        if (S.state) {
          S.state.hasMore = m.commits.length ? m.hasMore : false;   // 空页即末页：终止后续自动加载
          S.state.commitsLoaded = S.commits.length;
        }
        list.appended();
      } else {
        list.refresh();   // 失配（期间发生过刷新），复位加载状态
      }
      break;
    }
    case 'opProgress':
      S.activeOps.set(m.opId, { kind: m.kind, text: m.text, pct: m.pct });
      toolbar.updateProgress();
      break;
    case 'opResult':
      S.activeOps.delete(m.opId);
      toolbar.updateProgress();
      if (m.ok) toolbar.flash(m.kind);   // 按钮短暂闪绿，明确"点击已生效"
      if (!m.ok) {
        if (m.outputTail) {
          void confirmDialog(S.t('error'), `${m.message ?? ''}\n\n${m.outputTail}`, S.t('close'));
        } else {
          toast('error', m.message ?? S.t('error'));
        }
      } else if (m.message) {
        toast('info', m.message);
      }
      break;
    case 'notify':
      toast(m.level, m.message);
      break;
    case 'configChanged':
      S.config = m.config;
      // 语言即时切换：更新翻译函数并重建静态文案（列头/分区标题等，v0.7.1）
      S.lang = (m.language === 'en' ? 'en' : 'zh-CN') as Lang;
      S.t = createT(S.lang);
      applyLayout();
      applyView();
      list.configChanged();
      toolbar.update();
      sidebar.update();
      detail.configChanged();
      workview.update();
      commitBar.update();
      refreshAiModels();
      break;
    case 'themeChanged':
      applyThemeKind();
      list.selectionChanged();   // 触发 Canvas 用新主题色重绘
      break;

    // ---------- 工作副本（Commit 功能） ----------
    case 'workState': {
      const prevRepo = S.work.state?.repoId;
      if (m.state.repoId !== S.repoId && m.state.repoId !== prevRepo) break;   // 过期的其他仓库推送
      S.work.state = m.state;
      workview.update();
      toolbar.update();
      commitBar.update();
      break;
    }
    case 'showWork':
      app.setView('work');
      commitBar.focusInput();
      break;
    case 'aiChunk':
      commitBar.onAiChunk(m.text);
      break;
    case 'aiDone':
      commitBar.onAiDone(m.model, m.instructions);
      break;
    case 'aiError':
      commitBar.onAiError(m.code, m.message);
      break;
  }
});

postRaw({ t: 'bootstrap' });
