/**
 * 顶部工具栏（设计方案 4.3）：仓库/分支过滤选择、Fetch/Pull/Push、刷新、进度、设置。
 */
import { S, type App } from '../state';
import { el } from '../util';

export interface Toolbar {
  el: HTMLElement;
  update(): void;
  updateProgress(): void;
}

export function createToolbar(app: App): Toolbar {
  const root = el('div', 'gg-toolbar');
  const repoSel = el('select', 'gg-select gg-repo-sel') as HTMLSelectElement;
  repoSel.addEventListener('change', () => {
    if (repoSel.value) app.selectRepo(repoSel.value);
  });

  const branchLabel = el('span', 'gg-branch-label');
  const filterSel = el('select', 'gg-select gg-filter-sel') as HTMLSelectElement;
  filterSel.addEventListener('change', () => {
    app.setFilter(filterSel.value || null);
  });

  const fetchBtn = mkBtn('⟳', () => app.runFetch());
  const pullBtn = mkBtn('⤓', () => app.runPull());
  const pushBtn = mkBtn('⤒', () => app.runPush());
  fetchBtn.title = S.t('fetch');
  pullBtn.title = S.t('pull');
  pushBtn.title = S.t('push');
  const refreshBtn = mkBtn('⟲', () => app.runRefresh());
  refreshBtn.title = S.t('refresh');
  const gearBtn = mkBtn('⚙', () => app.openSettings());
  gearBtn.title = S.t('settings');

  const progress = el('div', 'gg-progress');
  const progressText = el('span', 'gg-progress-text');
  const progressCancel = el('button', 'gg-icon-btn', '×');
  let activeOpId: number | undefined;
  progressCancel.addEventListener('click', () => {
    if (activeOpId !== undefined) app.cancelOp(activeOpId);
  });
  progress.append(progressText, progressCancel);

  const left = el('div', 'gg-toolbar-left');
  left.append(repoSel, branchLabel, filterSel);
  const right = el('div', 'gg-toolbar-right');
  right.append(fetchBtn, pullBtn, pushBtn, refreshBtn, gearBtn, progress);
  root.append(left, right);

  function mkBtn(label: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'gg-tb-btn', label) as HTMLButtonElement;
    b.addEventListener('click', run);
    return b;
  }

  function update(): void {
    // 仓库下拉
    const multi = S.repos.length > 1;
    repoSel.classList.toggle('hidden', !multi);
    if (multi) {
      repoSel.textContent = '';
      for (const r of S.repos) {
        const opt = el('option', undefined, r.name) as HTMLOptionElement;
        opt.value = r.id;
        opt.selected = r.id === S.repoId;
        repoSel.appendChild(opt);
      }
    }
    // 当前分支标识
    const st = S.state;
    if (st) {
      branchLabel.textContent = st.head.detached
        ? `${S.t('detachedHead')} · ${st.head.sha.slice(0, 7)}`
        : `⑂ ${st.head.branch ?? ''}`;
      if (st.status.dirtyCount > 0) {
        const badge = el('span', 'gg-dirty-badge', S.t('dirtyCount', { n: st.status.dirtyCount }));
        branchLabel.appendChild(badge);
      }
    } else {
      branchLabel.textContent = '';
    }
    // 过滤下拉
    filterSel.textContent = '';
    const optAll = el('option', undefined, S.t('filterAll')) as HTMLOptionElement;
    optAll.value = '';
    filterSel.appendChild(optAll);
    if (st) {
      for (const b of st.branches) addOpt(filterSel, b.name, b.fullName, '⑂ ');
      for (const g of st.remotes) for (const b of g.branches) addOpt(filterSel, b.name, b.fullName, '');
      for (const tg of st.tags) addOpt(filterSel, tg.name, tg.name, '');
    }
    filterSel.value = st?.filterRef ?? '';
  }

  function addOpt(sel: HTMLSelectElement, label: string, value: string, prefix: string): void {
    const o = el('option', undefined, prefix + label) as HTMLOptionElement;
    o.value = value;
    sel.appendChild(o);
  }

  function updateProgress(): void {
    const ops = [...S.activeOps.entries()];
    if (!ops.length) {
      progress.classList.remove('show');
      activeOpId = undefined;
      return;
    }
    const [opId, op] = ops[ops.length - 1];
    activeOpId = opId;
    progress.classList.add('show');
    const pct = op.pct !== undefined ? ` ${op.pct}%` : '';
    progressText.textContent = `${S.t(op.kind)}${pct} · ${op.text}`;
  }

  return { el: root, update, updateProgress };
}
