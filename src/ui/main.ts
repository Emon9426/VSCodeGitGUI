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
import { createMergeView } from './app/mergeView';
import { createOpStatus } from './app/opStatus';
import { createFilesView } from './app/filesView';
import { createFilePanel } from './app/filePanel';
import { showPullSummary } from './app/pullSummary';
import { confirmDialog, promptDialog, resetDialog, toast, openModal } from './app/overlays';
import { fileIconSvg } from './icons';

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
      authors: [...new Set(f.authors.filter(Boolean))].slice(0, 50),
      since: DATE.test(f.since) ? f.since : '',
      until: DATE.test(f.until) ? f.until : '',
      noMerges: f.noMerges ?? S.logFilter.noMerges,
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
    const remote = head.upstream.split('/')[0];
    // R3 事前拦截：本地落后远端 → 引导先拉取（拉取并推送 = pull 后无冲突自动续推）
    if ((head.behind ?? 0) > 0) {
      void confirmDialog(
        S.t('pushBehindTitle'),
        S.t('pushBehindText', { n: String(head.behind) }),
        S.t('pushPullAndPush'),
        true,
      ).then(ok => {
        if (!ok) return;
        pendingPushAfterPull = true;
        app.runPull();
      });
      return;
    }
    void rpc('op:push', { remote, branch }).catch(showErr);
  },
  runRefresh() {
    void rpc('refresh')
      .then(() => toast('info', S.t('refreshDone')))
      .catch(showErr);
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
  openFiles(paths) {
    void rpc('ui:openFiles', { paths })
      .then(r => {
        if (r?.missing?.length) toast('warn', S.t('openFilesMissing', { n: r.missing.length }));
      })
      .catch(showErr);
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
    // 纯提交视图 ⇄ 提交图：切换 noMerges（数据侧 --no-merges + 日期序，repoState 重推列表）
    if (view === 'pure' || (view === 'graph' && S.logFilter.noMerges)) {
      app.setLogFilter({ ...S.logFilter, noMerges: view === 'pure' });
    }
    if (view === 'work') {
      void rpc('work.state').catch(showErr);
      loadDraftOnce();
      refreshAiModels();   // Copilot 登录状态可能变化，进出视图时刷新
    }
  },
  /** 作者多选下拉候选：首次打开时按需拉取（全历史姓名去重），仓库切换后失效 */
  listAuthors(): Promise<string[]> {
    if (S.authorsLoadedFor === S.repoId) return Promise.resolve(S.authors);
    return rpc('listAuthors')
      .then(list => {
        if (S.repoId !== undefined) {
          S.authors = Array.isArray(list) ? list : [];
          S.authorsLoadedFor = S.repoId;
        }
        return S.authors;
      });
  },
  // 刷新按钮：立即跑 git status（响应直达 UI；若状态有变，workState 事件亦会到达，二者幂等）
  requestWorkState() {
    void rpc('work.state')
      .then(st => {
        if (!st || st.repoId !== S.repoId) return;
        S.work.state = st;
        workview.update();
        toolbar.update();
        commitBar.update();
        commitBar.autoHidePushq();
        mergeview.update();
      })
      .catch(showErr);
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
  deleteFile(paths) {
    void rpc('work.deleteFile', { paths })
      .then(r => { if (r?.deleted > 0) toast('info', S.t('deleteFileDone', { n: r.deleted })); })
      .catch(showErr);
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
  // 合并解决器（v0.10）：语义侧 mine/theirs，扩展侧按 mergeKind 映射 ours/theirs
  openMerge(path) {
    const p = path ?? S.work.state?.conflicts[0]?.path;
    if (!p) { toast('warn', S.t('mergeNoConflictFile')); return; }
    mergeview.open(p);
  },
  mergeResolve(path, sideTheirs) {
    void rpc('merge.resolve', { path, side: sideTheirs ? 'theirs' : 'mine' }).catch(showErr);
  },
  mergeAbort() {
    void confirmDialog(S.t('mergeAbortTitle'), S.t('mergeAbortText'), S.t('mergeAbortConfirmBtn'), true).then(ok => {
      if (ok) void rpc('merge.abort').catch(showErr);
    });
  },
  mergeFinishAsk() {
    const isRebase = S.work.state?.mergeKind === 'rebase';
    const title = isRebase ? S.t('mergeRebaseFinishTitle') : S.t('mergeFinishTitle');
    const text = isRebase ? S.t('mergeRebaseFinishText') : S.t('mergeFinishText');
    void confirmDialog(title, text, isRebase ? S.t('mergeRebaseFinishBtn') : S.t('mergeFinishBtn2'), true).then(ok => {
      if (ok) void rpc('merge.finish').catch(showErr);
    });
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
  // 工程切换（v0.11）
  projectAdd(path, name) {
    void rpc('projects.add', { path, name }).catch(showErr);
  },
  projectRename(id, name) {
    void rpc('projects.rename', { id, name }).catch(showErr);
  },
  projectRemove(id) {
    void rpc('projects.remove', { id }).catch(showErr);
  },
  projectPickFolder() {
    return rpc('projects.pickFolder')
      .then(r => (r && typeof r.path === 'string' ? r.path : null))
      .catch(() => null);
  },
  projectOpen(id, newWindow) {
    void rpc('projects.open', { id, newWindow }).catch(showErr);
  },
  // ---------- 文件历史页（v0.14） ----------
  filesNavigate(dir, opts) {
    S.files.cwd = dir;
    S.files.lsLoading = true;
    filesview.update();
    void rpc('files.ls', { dir })
      .then(r => {
        if (S.files.cwd !== dir) return;   // 已导航他处：丢弃过期响应
        S.files.lsLoading = false;
        if (r?.kind === 'dir') {
          S.files.items = Array.isArray(r.items) ? r.items : [];
          S.files.sel = [];
          if (opts?.select && S.files.items.some(x => x.path === opts.select)) {
            S.files.sel = [opts.select];
            S.files.anchor = opts.select;
            app.filesSelect(opts.select, !!S.files.items.find(x => x.path === opts.select)?.isDir);
          }
          filesview.update();
        } else if (r?.kind === 'file') {
          // 防御：目录参数实为文件（地址栏场景已在组件内预处理）
          const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
          if (parent !== dir) app.filesNavigate(parent, { select: dir });
        } else {
          toast('warn', S.t('filesAddrNone', { p: dir }));
        }
      })
      .catch(e => { S.files.lsLoading = false; showErr(e); });
  },
  filesSelect(path, isDir) {
    S.files.histFor = path;
    S.files.histIsDir = isDir;
    S.files.histLoading = true;
    S.files.detailSha = undefined;
    S.files.detailDiff = undefined;
    S.files.picked = [];
    S.files.diff = undefined;
    S.files.diffPair = undefined;
    filepanel.update();
    const followWanted = S.files.follow;
    const cmd = isDir ? 'files.dirLog' : 'files.log';
    const payload = isDir ? { dir: path, follow: followWanted } : { path };
    void rpc(cmd, payload)
      .then(r => {
        if (S.files.histFor !== path || S.files.follow !== followWanted) return;   // 过期响应
        S.files.histLoading = false;
        S.files.history = r ?? undefined;
        filepanel.update();
      })
      .catch(e => {
        if (S.files.histFor === path && S.files.follow === followWanted) {
          S.files.histLoading = false;
          filepanel.update();
        }
        showErr(e);
      });
  },
  filesCommitDiff(sha, path) {
    void rpc('files.commitDiff', { sha, path })
      .then(p => {
        if (S.files.detailSha === sha) { S.files.detailDiff = p; filepanel.update(); }
      })
      .catch(showErr);
  },
  filesVersionDiff() {
    const [a, b] = S.files.picked;
    if (!a || !b) return;
    void rpc('files.versionDiff', { a: { sha: a.sha, path: a.path }, b: { sha: b.sha, path: b.path } })
      .then(p => { S.files.diff = p; S.files.diffPair = { a, b }; filepanel.update(); })
      .catch(showErr);
  },
  folderMove(srcs) {
    void moveDialog(srcs).then(dst => {
      if (dst === null) return;   // 用户取消
      void rpc('folder.move', { srcs, dst })
        .then(r => {
          if (!r) return;
          if (!r.ok) {
            if (r.reason !== 'cancelled') toast('error', S.t('moveFailed') + (r.error ? `：${String(r.error).slice(0, 200)}` : ''));
            return;
          }
          const from = srcs[0]?.includes('/') ? srcs[0].slice(0, srcs[0].lastIndexOf('/')) : '';
          S.files.moveBanner = { srcs, dst: String(r.dst ?? ''), from };
          S.files.sel = [];
          app.filesNavigate(S.files.cwd);
          filepanel.update();
          toast('info', S.t('moveDone', { n: String(srcs.length) }));
        })
        .catch(showErr);
    });
  },
  folderRename(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    void promptDialog(S.t('filesRename'), S.t('filesRenameLabel'), name).then(nn => {
      if (!nn || nn === name || !nn.trim()) return;
      void rpc('folder.rename', { path, newName: nn.trim() })
        .then(() => {
          toast('info', S.t('renameDone', { from: name, to: nn.trim() }));
          const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
          app.filesNavigate(parent, { select: parent ? parent + '/' + nn.trim() : nn.trim() });
        })
        .catch(showErr);
    });
  },
  folderDelete(paths) {
    void confirmDialog(S.t('filesDelete'), S.t('filesDeleteConfirm', { n: String(paths.length) }), S.t('filesDelete'), true).then(ok => {
      if (!ok) return;
      void rpc('folder.delete', { paths })
        .then(() => {
          S.files.sel = [];
          app.filesNavigate(S.files.cwd);
          toast('info', S.t('deleteDone', { n: String(paths.length) }));
        })
        .catch(showErr);
    });
  },
  saveFilesLayout(paneW, cols) {
    void rpc('ui:saveFilesLayout', { paneW, cols }).catch(() => undefined);
  },
  toggleSide() {
    S.sideCollapsed = !S.sideCollapsed;
    void rpc('ui:saveSideCollapsed', { collapsed: S.sideCollapsed }).catch(() => undefined);
    applyLayout();
    toolbar.update();
  },
};

function showErr(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  toast('error', msg);
}

/** 移动目标选择对话框（webview 内实现——原生 showOpenDialog 在部分环境静默取消，已弃用）：
 *  仓库内目录浏览（files.ls 懒加载子目录）+「移动到此处」确认；返回目标相对路径或 null（取消）。 */
function moveDialog(srcs: string[]): Promise<string | null> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(S.t('moveDlgTitle', { n: String(srcs.length) }));
    box.classList.add('gg-move-dlg');
    // 初始目录=首个源文件所在目录（资源管理器"移动到"惯例；多选取第一项父目录）
    const first = srcs[0] ?? '';
    let cwd = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    box.addEventListener('keydown', e => { if (e.key === 'Escape') finish(null); });

    const crumbs = el('div', 'gg-move-crumbs');
    const list = el('div', 'gg-move-list');
    const hint = el('div', 'gg-move-hint');
    const foot = el('div', 'gg-move-foot');
    const cancelBtn = el('button', 'gg-btn', S.t('cancel'));
    const okBtn = el('button', 'gg-btn primary', S.t('moveDlgHere'));
    cancelBtn.addEventListener('click', () => finish(null));
    okBtn.addEventListener('click', () => finish(cwd));
    foot.append(cancelBtn, okBtn);
    body.append(crumbs, list, hint, foot);

    function renderCrumbs(): void {
      crumbs.textContent = '';
      const mk = (label: string, p: string, cur?: boolean) => {
        const c = el('span', 'gg-move-crumb' + (cur ? ' cur' : ''), label);
        c.addEventListener('click', () => { cwd = p; load(); });
        return c;
      };
      crumbs.append(mk('🏠 ' + S.t('filesRootCrumb'), '', cwd === ''));
      let acc = '';
      for (const seg of cwd ? cwd.split('/') : []) {
        acc = acc ? acc + '/' + seg : seg;
        crumbs.append(el('span', 'gg-move-sep', '›'), mk(seg, acc, acc === cwd));
      }
    }

    function load(): void {
      renderCrumbs();
      list.textContent = '';
      list.append(el('div', 'gg-move-loading', S.t('loading')));
      // 嵌套目标（目标在任一源路径内）禁止确认
      const nested = srcs.some(s => cwd === s || cwd.startsWith(s + '/'));
      okBtn.classList.toggle('dis', nested);
      hint.textContent = nested ? S.t('moveDlgNested') : '';
      void rpc('files.ls', { dir: cwd })
        .then(r => {
          if (done) return;
          list.textContent = '';
          const dirs = (r?.items ?? []).filter((x: any) => x.isDir) as { name: string; path: string }[];
          if (!dirs.length) list.append(el('div', 'gg-move-loading', S.t('filesEmptyDir')));
          for (const d of dirs) {
            const row = el('div', 'gg-move-row');
            const ic = fileIconSvg(d.name, true);
            row.append(ic, el('span', 'gg-move-row-nm', d.name));
            row.addEventListener('click', () => { cwd = d.path; load(); });
            list.append(row);
          }
        })
        .catch(e => { list.textContent = ''; list.append(el('div', 'gg-move-loading', String((e as Error)?.message ?? e))); });
    }
    load();
  });
}

// ---------- 布局 ----------

const toolbar = createToolbar(app);
const opstatus = createOpStatus(app);
const sidebar = createSidebar(app);
const list = createCommitList(app);
const detail = createDetailPanel(app);
const workview = createWorkView(app);
const commitBar = createCommitBar(app);
const mergeview = createMergeView(app);
const filesview = createFilesView(app, { onSelection: () => filepanel.update() });
const filepanel = createFilePanel(app);

const mainEl = el('div', 'gg-main');
const workWrap = el('div', 'gg-work-wrap hidden');
workWrap.append(workview.el, commitBar.el);
const filesWrap = el('div', 'gg-files-wrap hidden');
filesWrap.append(filesview.el, filesview.splitter, filepanel.el);
mainEl.append(list.el, detail.el, workWrap, filesWrap);
const bodyEl = el('div', 'gg-body');
// 侧栏折叠后的左缘展开把手（side-off 时显示，点击恢复侧栏）
const sideEdge = el('button', 'gg-side-edge hidden');
sideEdge.title = '';
sideEdge.addEventListener('click', () => app.toggleSide());
bodyEl.append(sidebar.el, sideEdge, mainEl);
const host = document.getElementById('app');
if (host) {
  host.append(toolbar.el, opstatus.el, bodyEl, mergeview.el);
} else {
  document.body.append(toolbar.el, opstatus.el, bodyEl, mergeview.el);
}

function applyLayout(): void {
  mainEl.classList.toggle('detail-right', S.config.detailPanelPosition === 'right');
  bodyEl.classList.toggle('side-off', S.sideCollapsed);
  sideEdge.classList.toggle('hidden', !S.sideCollapsed);
  sideEdge.title = S.t('sideShow');
}

/** 视图切换：display 切换不销毁 DOM（草稿/滚动/选中全部保留）；pure 复用提交列表（隐藏图形列） */
function applyView(): void {
  const work = S.view === 'work';
  const files = S.view === 'files';
  bodyEl.classList.toggle('work-mode', work);
  list.el.classList.toggle('hidden', work || files);
  detail.el.classList.toggle('hidden', work || files);
  workWrap.classList.toggle('hidden', !work);
  filesWrap.classList.toggle('hidden', !files);
  filesview.splitter.classList.toggle('hidden', !files);
  if (files && !S.files.items.length && !S.files.lsLoading) app.filesNavigate('');
  list.viewChanged();
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
/** 连续空页计数（Issue #5）：带日期窗口时补扫达 SCAN_CAP 会返回空页+hasMore=true（如实续扫），
 *  自动加载在 syncRows 内触发、空列表下条件恒真——连续 ≥2 次空页即熔断，防无限打满扫描块 */
let emptyAppendStreak = 0;
/** 「拉取并推送」链条：pull 完成且无冲突时自动续推（R3/决议 #3 的事前引导侧） */
let pendingPushAfterPull = false;

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
      // v0.14.7：ready 可能先于 git 探测到达（reposPending=true）——外壳先行渲染，
      // 仓库列表由随后的 reposChanged 补发；旧版扩展不带该字段时视为已就绪
      S.reposPending = !!m.reposPending && m.repos.length === 0;
      S.version = m.version ?? '';
      S.detailPct = typeof m.detailPct === 'number' ? m.detailPct : undefined;
      S.projects = m.projects ?? [];
      S.activeProjectIds = m.activeProjectIds ?? [];
      S.workspaceFolders = m.workspaceFolders ?? [];
      if (m.colWidths) applyColWidths(m.colWidths);
      if (m.filesLayout) {
        S.files.paneW = Math.max(280, Math.min(640, Math.round(m.filesLayout.paneW) || 388));
        S.files.cols = Array.isArray(m.filesLayout.cols) ? m.filesLayout.cols.map(n => Math.max(40, Math.round(n))) : undefined;
        filesview.el.style.width = S.files.paneW + 'px';
      }
      if (typeof m.sideCollapsed === 'boolean') S.sideCollapsed = m.sideCollapsed;
      if (typeof m.workFilesW === 'number') workview.applyFilesWidth(m.workFilesW);   // 工作副本列宽跨会话恢复
      restoreSha = m.selectedSha;
      applyThemeKind();
      detail.applyHeightPct();   // 先恢复高度再渲染，避免 220px 默认值闪跳
      list.configChanged();
      toolbar.update();
      sidebar.update();
      detail.update();
      applyLayout();
      applyView();
      refreshAiModels();
      break;
    case 'reposChanged':
      // 仓库扫描完成（v0.14.7）：更新仓库列表并解除扫描态；空列表 → 主区显示无仓库引导
      S.repos = m.repos;
      S.reposPending = false;
      toolbar.update();
      sidebar.update();
      list.refresh();
      break;
    case 'repoState': {
      const st = m.state;
      S.reposPending = false;   // 首个仓库状态到达 ⇒ 启动加载态结束（兜底，正常已由 reposChanged 解除）
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
        // 文件页：换仓库 → 目录/选中/历史全部复位
        filesview.reset();
        filepanel.reset();
      } else if (S.selectedSha && !st.commits.some(c => c.sha === S.selectedSha)) {
        S.selectedSha = undefined;
        S.detail = undefined;
        S.diff = undefined;
        S.selectedFile = undefined;
      }
      S.state = st;
      S.commits = st.commits;
      S.graph = computeLanes(st.commits);
      emptyAppendStreak = 0;   // 列表整体重建：空页熔断计数随新快照复位
      // 列表已整体重建：作废在途分页请求（其页属旧快照，拼接必错位）
      pendingLoad = undefined;
      if (st.logFilter) S.logFilter = st.logFilter;
      if (repoChanged) list.reset(); else list.refresh();
      sidebar.update();
      toolbar.update();
      commitBar.autoHidePushq();   // 已无待推送（如从其他入口推送完成）→ 推送询问条让位
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
          emptyAppendStreak = 0;
          S.commits.push(...m.commits);
          S.graph = computeLanes(S.commits);
        } else {
          emptyAppendStreak++;
        }
        if (S.state) {
          // 空页语义（Issue #5）：真扫尽时宿主 hasMore 本为 false（与 v0.7.2「空页即末页」等价）；
          // 补扫达 SCAN_CAP 的空页 hasMore=true——首次保留续扫通道，连续第二次空页熔断自动加载
          S.state.hasMore = m.commits.length ? m.hasMore : (emptyAppendStreak >= 2 ? false : m.hasMore);
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
      opstatus.update();
      toolbar.updateProgress();
      break;
    case 'opResult':
      S.activeOps.delete(m.opId);
      opstatus.update();          // 先按剩余队列收起/切换
      if (m.ok) {
        opstatus.finish(m.kind);  // 成功：绿色闪现（队列有后续会被立即切换）
        toolbar.flash(m.kind);    // 按钮短暂闪绿，明确"点击已生效"
      }
      toolbar.updateProgress();
      if (!m.ok) {
        // R3 事后兜底：push 被拒（non-fast-forward / fetch first / rejected）→ 引导先拉取
        if (m.kind === 'push' && m.outputTail && /non-fast-forward|fetch first|rejected|failed to push/i.test(m.outputTail)) {
          void confirmDialog(
            S.t('pushRejectedTitle'),
            S.t('pushRejectedText'),
            S.t('pushPullAndPush'),
            true,
          ).then(ok => {
            if (!ok) return;
            pendingPushAfterPull = true;
            app.runPull();
          });
        } else if (m.outputTail) {
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
    case 'projectsChanged':
      S.projects = m.projects;
      S.activeProjectIds = m.activeProjectIds;
      sidebar.update();
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
      filesview.update();
      filepanel.update();
      refreshAiModels();
      break;
    case 'themeChanged':
      applyThemeKind();
      list.selectionChanged();   // 触发 Canvas 用新主题色重绘
      break;
    // 文件历史页（v0.14）：explorer 右键「查看文件历史」→ 切文件视图并定位选中
    case 'filesReveal': {
      S.view = 'files';
      applyView();
      const p = String(m.path || '');
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      app.filesNavigate(dir, { select: p });
      break;
    }

    // ---------- 工作副本（Commit 功能） ----------
    case 'workState': {
      const prevRepo = S.work.state?.repoId;
      if (m.state.repoId !== S.repoId && m.state.repoId !== prevRepo) break;   // 过期的其他仓库推送
      S.work.state = m.state;
      workview.update();
      toolbar.update();
      commitBar.update();
      commitBar.autoHidePushq();   // 工作区已干净 → 推送询问条让位（干净空态自带推送按钮）
      mergeview.update();
      // R3 引导：出现冲突时自动切到工作副本视图（横幅即在该视图顶部）
      if (m.state.merging && S.view !== 'work') app.setView('work');
      // 「拉取并推送」链条：pull 完成后无冲突 → 自动续推（有冲突则停在横幅流程，由用户解决后确认）
      if (pendingPushAfterPull) {
        if (!m.state.merging) {
          pendingPushAfterPull = false;
          app.runPush();
        } else {
          pendingPushAfterPull = false;
          toast('warn', S.t('mergePushPaused'));
        }
      }
      break;
    }
    case 'showWork':
      app.setView('work');
      commitBar.focusInput();
      break;
    case 'pullSummary':
      showPullSummary(m.kind, m.entries, m.truncated, m.stat, app);
      break;
    case 'aiChunk':
      commitBar.onAiChunk(m.text);
      break;
    case 'aiDone':
      commitBar.onAiDone(m.model, m.instructions, m.fallback);
      break;
    case 'aiError':
      commitBar.onAiError(m.code, m.message);
      break;
  }
});

postRaw({ t: 'bootstrap' });
