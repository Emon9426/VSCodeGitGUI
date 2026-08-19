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
    void rpc('setFilter', { ref }).catch(showErr);
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
    void rpc('loadMore', { offset: S.commits.length })
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
    void rpc('refresh').catch(showErr);
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

const mainEl = el('div', 'gg-main');
mainEl.append(list.el, detail.el);
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
applyLayout();

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
      if (m.colWidths) applyColWidths(m.colWidths);
      list.configChanged();
      toolbar.update();
      sidebar.update();
      detail.update();
      applyLayout();
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
      } else if (S.selectedSha && !st.commits.some(c => c.sha === S.selectedSha)) {
        S.selectedSha = undefined;
        S.detail = undefined;
        S.diff = undefined;
        S.selectedFile = undefined;
      }
      S.state = st;
      S.commits = st.commits;
      S.graph = computeLanes(st.commits);
      if (repoChanged) list.reset(); else list.refresh();
      sidebar.update();
      toolbar.update();
      detail.update();
      // 刷新后选中仍在但详情缺失（如请求曾被刷新打断）：自动补拉
      if (S.selectedSha && !S.detailLoading && S.detail?.sha !== S.selectedSha) {
        app.selectCommit(S.selectedSha);
      }
      break;
    }
    case 'commitsAppend': {
      if (m.repoId !== S.repoId) { list.refresh(); break; }
      if (m.offset === S.commits.length && m.commits.length) {
        S.commits.push(...m.commits);
        S.graph = computeLanes(S.commits);
        if (S.state) {
          S.state.hasMore = m.hasMore;
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
      applyLayout();
      list.configChanged();
      toolbar.update();
      sidebar.update();
      detail.configChanged();
      break;
    case 'themeChanged':
      list.selectionChanged();   // 触发 Canvas 用新主题色重绘
      break;
  }
});

postRaw({ t: 'bootstrap' });
