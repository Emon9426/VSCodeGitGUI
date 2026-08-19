/**
 * 顶部工具栏（设计方案 4.3）：仓库/分支过滤选择、作者+时间段筛选、Fetch/Pull/Push、刷新、进度、设置。
 */
import { S, type App } from '../state';
import { el, debounce } from '../util';

export interface Toolbar {
  el: HTMLElement;
  update(): void;
  updateProgress(): void;
  /** 用后端状态同步筛选输入框（避免打断正在输入的用户跳过聚焦元素） */
  syncFilterInputs(f: { author: string; since: string; until: string }): void;
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

  // 作者 + 时间段筛选
  const authorInput = el('input', 'gg-filter-input gg-author-input') as HTMLInputElement;
  authorInput.placeholder = S.t('filterAuthor');
  authorInput.title = S.t('filterAuthor');
  const sinceInput = el('input', 'gg-filter-input gg-date-input') as HTMLInputElement;
  sinceInput.type = 'date';
  sinceInput.title = S.t('filterSince');
  const untilInput = el('input', 'gg-filter-input gg-date-input') as HTMLInputElement;
  untilInput.type = 'date';
  untilInput.title = S.t('filterUntil');
  const clearBtn = el('button', 'gg-tb-btn gg-clear-btn hidden', '×') as HTMLButtonElement;
  clearBtn.title = S.t('clearFilter');
  const filterBox = el('div', 'gg-logfilter');
  filterBox.append(authorInput, sinceInput, el('span', 'gg-range-sep', '–'), untilInput, clearBtn);

  const applySoon = debounce(() => {
    app.setLogFilter({ author: authorInput.value, since: sinceInput.value, until: untilInput.value });
  }, 450);
  authorInput.addEventListener('input', applySoon);
  sinceInput.addEventListener('change', applySoon);
  untilInput.addEventListener('change', applySoon);
  const updateClearVis = () => {
    clearBtn.classList.toggle('hidden', !(authorInput.value || sinceInput.value || untilInput.value));
  };
  authorInput.addEventListener('input', updateClearVis);
  sinceInput.addEventListener('change', updateClearVis);
  untilInput.addEventListener('change', updateClearVis);
  clearBtn.addEventListener('click', () => {
    authorInput.value = '';
    sinceInput.value = '';
    untilInput.value = '';
    updateClearVis();
    app.setLogFilter({ author: '', since: '', until: '' });
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
  const versionLabel = el('span', 'gg-version-label', '');

  const progress = el('div', 'gg-progress');
  const progressText = el('span', 'gg-progress-text');
  const progressCancel = el('button', 'gg-icon-btn', '×');
  let activeOpId: number | undefined;
  progressCancel.addEventListener('click', () => {
    if (activeOpId !== undefined) app.cancelOp(activeOpId);
  });
  progress.append(progressText, progressCancel);

  const left = el('div', 'gg-toolbar-left');
  left.append(repoSel, branchLabel, filterSel, filterBox);
  const right = el('div', 'gg-toolbar-right');
  right.append(fetchBtn, pullBtn, pushBtn, refreshBtn, gearBtn, versionLabel, progress);
  root.append(left, right);

  function mkBtn(label: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'gg-tb-btn', label) as HTMLButtonElement;
    b.addEventListener('click', run);
    return b;
  }

  function update(): void {
    versionLabel.textContent = S.version ? `v${S.version}` : '';
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

  function syncFilterInputs(f: { author: string; since: string; until: string }): void {
    const focusIn = document.activeElement === authorInput
      || document.activeElement === sinceInput
      || document.activeElement === untilInput;
    if (focusIn) return;   // 用户正在编辑，不覆盖
    if (authorInput.value !== f.author) authorInput.value = f.author;
    if (sinceInput.value !== f.since) sinceInput.value = f.since;
    if (untilInput.value !== f.until) untilInput.value = f.until;
    updateClearVis();
  }

  return { el: root, update, updateProgress, syncFilterInputs };
}
