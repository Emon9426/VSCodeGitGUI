/**
 * 顶部工具栏（设计方案 4.3）：仓库/分支过滤选择、作者多选下拉+时间段筛选、Fetch/Pull/Push、刷新、进度、设置。
 */
import { S, type App } from '../state';
import { el, clearChildren, debounce } from '../util';

export interface Toolbar {
  el: HTMLElement;
  update(): void;
  updateProgress(): void;
  /** 用后端状态同步筛选控件（避免打断正在输入的用户跳过聚焦元素） */
  syncFilterInputs(f: { authors: string[]; since: string; until: string }): void;
  /** 操作成功后在对应按钮上短暂闪绿（v0.7.1 反馈优化） */
  flash(kind: string): void;
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

  // ---------- 作者多选下拉（搜索 + 复选）+ 时间段筛选 ----------
  const authorBox = el('div', 'gg-author-dd');
  const authorBtn = el('button', 'gg-author-btn') as HTMLButtonElement;
  const authorLabel = el('span', 'gg-author-label');
  const authorCaret = el('span', 'gg-author-caret', '▾');
  authorBtn.append(authorLabel, authorCaret);
  const authorPop = el('div', 'gg-author-pop hidden');
  const authorSearch = el('input', 'gg-author-search') as HTMLInputElement;
  const authorListEl = el('div', 'gg-author-list');
  const authorFoot = el('div', 'gg-author-foot');
  const authorAllBtn = el('button', 'gg-btn tiny') as HTMLButtonElement;
  const authorCount = el('span', 'gg-author-count');
  const authorNoneBtn = el('button', 'gg-btn tiny') as HTMLButtonElement;
  authorFoot.append(authorAllBtn, authorCount, authorNoneBtn);
  authorPop.append(authorSearch, authorListEl, authorFoot);
  authorBox.append(authorBtn, authorPop);

  const sinceInput = el('input', 'gg-filter-input gg-date-input') as HTMLInputElement;
  sinceInput.type = 'date';
  sinceInput.title = S.t('filterSince');
  const untilInput = el('input', 'gg-filter-input gg-date-input') as HTMLInputElement;
  untilInput.type = 'date';
  untilInput.title = S.t('filterUntil');
  const clearBtn = el('button', 'gg-tb-btn gg-clear-btn hidden', '×') as HTMLButtonElement;
  clearBtn.title = S.t('clearFilter');
  const filterBox = el('div', 'gg-logfilter');
  filterBox.append(authorBox, sinceInput, el('span', 'gg-range-sep', '–'), untilInput, clearBtn);

  /** 已选作者集合（与 S.logFilter.authors 双向同步；勾选即时生效，统一防抖提交） */
  const sel = new Set<string>();
  let authorCandidates: string[] = [];

  const applySoon = debounce(() => {
    app.setLogFilter({ authors: [...sel], since: sinceInput.value, until: untilInput.value });
  }, 350);

  function updateAuthorBtn(): void {
    const n = sel.size;
    authorLabel.textContent = n === 0 ? S.t('filterAuthor') : n === 1 ? [...sel][0] : S.t('authorsSelected', { n: String(n) });
    authorBtn.classList.toggle('active', n > 0);
    authorBtn.title = n > 0 ? [...sel].join(', ') : S.t('filterAuthor');
    authorCount.textContent = S.t('authorsCount', { n: String(n), total: String(authorCandidates.length) });
    updateClearVis();
  }

  function renderAuthorList(): void {
    clearChildren(authorListEl);
    const q = authorSearch.value.trim().toLowerCase();
    const list = authorCandidates.filter(a => !q || a.toLowerCase().includes(q));
    if (!list.length) {
      authorListEl.appendChild(el('div', 'gg-author-empty', authorCandidates.length ? S.t('noMatches') : S.t('loading')));
      updateAuthorBtn();
      return;
    }
    for (const name of list) {
      const item = el('label', 'gg-author-item');
      const cb = el('input') as HTMLInputElement;
      cb.type = 'checkbox';
      cb.checked = sel.has(name);
      cb.addEventListener('change', () => {
        if (cb.checked) sel.add(name); else sel.delete(name);
        updateAuthorBtn();
        applySoon();
      });
      item.append(cb, el('span', 'gg-author-name', name));
      authorListEl.appendChild(item);
    }
    updateAuthorBtn();
  }

  function openAuthorPop(): void {
    authorPop.classList.remove('hidden');
    authorSearch.value = '';
    renderAuthorList();
    authorSearch.focus();
    if (!authorCandidates.length) {
      void app.listAuthors().then(list => {
        authorCandidates = list;
        if (!authorPop.classList.contains('hidden')) renderAuthorList();
      });
    }
  }

  function closeAuthorPop(): void {
    authorPop.classList.add('hidden');
  }

  authorBtn.addEventListener('click', () => {
    if (authorPop.classList.contains('hidden')) openAuthorPop(); else closeAuthorPop();
  });
  document.addEventListener('mousedown', e => {
    if (!authorPop.classList.contains('hidden') && !authorBox.contains(e.target as Node)) closeAuthorPop();
  });
  authorPop.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeAuthorPop(); authorBtn.focus(); }
  });
  authorSearch.addEventListener('input', renderAuthorList);
  authorAllBtn.addEventListener('click', () => {
    const q = authorSearch.value.trim().toLowerCase();
    for (const name of authorCandidates) {
      if (!q || name.toLowerCase().includes(q)) sel.add(name);
    }
    renderAuthorList();
    applySoon();
  });
  authorNoneBtn.addEventListener('click', () => {
    sel.clear();
    renderAuthorList();
    applySoon();
  });

  // 选起始日期时自动带入截止 = 起始（Issue #5）：仅截止为空时带入，不覆盖用户已选值；
  // 注册在 applySoon/updateClearVis 之前，防抖发送与 × 按钮可见性读到带入后的值
  sinceInput.addEventListener('change', () => {
    if (sinceInput.value && !untilInput.value) untilInput.value = sinceInput.value;
  });
  sinceInput.addEventListener('change', applySoon);
  untilInput.addEventListener('change', applySoon);
  function updateClearVis(): void {
    clearBtn.classList.toggle('hidden', !(sel.size || sinceInput.value || untilInput.value));
  }
  sinceInput.addEventListener('change', updateClearVis);
  untilInput.addEventListener('change', updateClearVis);
  clearBtn.addEventListener('click', () => {
    sel.clear();
    sinceInput.value = '';
    untilInput.value = '';
    updateAuthorBtn();
    updateClearVis();
    if (!authorPop.classList.contains('hidden')) renderAuthorList();
    app.setLogFilter({ authors: [], since: '', until: '' });
  });

  const fetchBtn = mkBtn('⟳', () => app.runFetch());
  const pullBtn = mkBtn('⤓', () => app.runPull());
  const pushBtn = mkBtn('⤒', () => app.runPush());
  fetchBtn.title = S.t('fetch');
  pullBtn.title = S.t('pull');
  pushBtn.title = S.t('push');
  const refreshBtn = mkBtn('⟲', () => app.runRefresh());
  refreshBtn.title = S.t('refresh');
  // 语言快捷切换（A/中/EN，点击弹三选一）
  const langBtn = mkBtn('', () => app.pickLanguage());
  const gearBtn = mkBtn('⚙', () => app.openSettings());
  gearBtn.title = S.t('settings');
  const versionLabel = el('span', 'gg-version-label', '');

  // 视图切换：提交图 ⇄ 纯提交列表 ⇄ 工作副本 ⇄ 文件历史（v0.14 第四视图；纯列表隐藏合并提交）
  const viewSeg = el('div', 'gg-viewseg');
  const graphBtn = el('button', 'gg-viewseg-btn', `⎔ ${S.t('viewGraph')}`) as HTMLButtonElement;
  const pureBtn = el('button', 'gg-viewseg-btn') as HTMLButtonElement;
  const pureLabel = el('span', undefined, `☰ ${S.t('viewPure')}`);
  pureBtn.append(pureLabel);
  const workBtn = el('button', 'gg-viewseg-btn') as HTMLButtonElement;
  const workLabel = el('span', undefined, `▣ ${S.t('viewWork')}`);
  const workBadge = el('span', 'gg-viewseg-badge hidden');
  workBtn.append(workLabel, workBadge);
  const filesBtn = el('button', 'gg-viewseg-btn') as HTMLButtonElement;
  const filesLabel = el('span', undefined, `🗂 ${S.t('viewFiles')}`);
  filesBtn.append(filesLabel);
  graphBtn.addEventListener('click', () => app.setView('graph'));
  pureBtn.addEventListener('click', () => app.setView('pure'));
  workBtn.addEventListener('click', () => app.setView('work'));
  filesBtn.addEventListener('click', () => app.setView('files'));
  viewSeg.append(graphBtn, pureBtn, workBtn, filesBtn);

  // 侧栏折叠切换（工程/仓库/分支/远程向左收起；折叠后左缘把手展开，v0.14.1）
  const sideToggle = el('button', 'gg-tb-btn gg-side-toggle') as HTMLButtonElement;
  sideToggle.addEventListener('click', () => app.toggleSide());

  const left = el('div', 'gg-toolbar-left');
  left.append(sideToggle, viewSeg, repoSel, branchLabel, filterSel, filterBox);
  const right = el('div', 'gg-toolbar-right');
  right.append(fetchBtn, pullBtn, pushBtn, refreshBtn, langBtn, gearBtn, versionLabel);
  root.append(left, right);

  function mkBtn(label: string, run: () => void): HTMLButtonElement {
    const b = el('button', 'gg-tb-btn', label) as HTMLButtonElement;
    b.addEventListener('click', run);
    return b;
  }

  function update(): void {
    versionLabel.textContent = S.version ? `v${S.version}` : '';
    // 视图分段控件（文案随语言刷新；含子节点的按钮只改 label span）
    graphBtn.classList.toggle('on', S.view === 'graph');
    pureBtn.classList.toggle('on', S.view === 'pure');
    workBtn.classList.toggle('on', S.view === 'work');
    filesBtn.classList.toggle('on', S.view === 'files');
    graphBtn.textContent = `⎔ ${S.t('viewGraph')}`;
    pureLabel.textContent = `☰ ${S.t('viewPure')}`;
    workLabel.textContent = `▣ ${S.t('viewWork')}`;
    filesLabel.textContent = `🗂 ${S.t('viewFiles')}`;
    graphBtn.title = S.t('viewGraphTip');
    pureBtn.title = S.t('viewPureTip');
    workBtn.title = S.t('viewWorkTip');
    filesBtn.title = S.t('viewFilesTip');
    // 侧栏折叠：按钮箭头随状态（« 收起 / » 展开），折叠态高亮提示
    sideToggle.textContent = S.sideCollapsed ? '»' : '«';
    sideToggle.title = S.sideCollapsed ? S.t('sideShow') : S.t('sideHide');
    sideToggle.classList.toggle('on', S.sideCollapsed);
    // 作者下拉文案
    authorSearch.placeholder = S.t('searchAuthor');
    authorAllBtn.textContent = S.t('selectAll');
    authorNoneBtn.textContent = S.t('clearSel');
    updateAuthorBtn();
    const lang = S.config.language;
    langBtn.textContent = lang === 'zh-CN' ? '中' : lang === 'en' ? 'EN' : 'A';
    langBtn.title = `${S.t('langSwitchTitle')} — ${lang === 'auto' ? S.t('langAuto') : lang === 'zh-CN' ? '简体中文' : 'English'}`;
    // 网络操作按钮 title 统一由 updateProgress 管理（B3：在途/排队状态优先）
    // B2（Issue #18）：存在未完成合并 → Push 预禁用并给原因（决策类引导仍走横幅/模态）
    const mergeBlocked = !!S.work.state?.mergeActive;
    pushBtn.disabled = mergeBlocked;
    if (mergeBlocked) pushBtn.title = S.t('blockedByMerge');
    updateProgress();
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

  function addOpt(selEl: HTMLSelectElement, label: string, value: string, prefix: string): void {
    const o = el('option', undefined, prefix + label) as HTMLOptionElement;
    o.value = value;
    selEl.appendChild(o);
  }

  function updateProgress(): void {
    const kinds = new Set([...S.activeOps.values()].map(o => o.kind));
    fetchBtn.classList.toggle('busy', kinds.has('fetch'));
    pullBtn.classList.toggle('busy', kinds.has('pull'));
    pushBtn.classList.toggle('busy', kinds.has('push'));
    refreshBtn.classList.toggle('busy', kinds.has('refresh'));
    // B3（Issue #18）：在途/排队状态写入 title——按钮可点击（同 kind 宿主去重、异 kind 入队可见），
    // 不再以 pointer-events:none 静默吞点击（R4：排队要透明）
    opTitle(fetchBtn, 'fetch', S.t('fetch'));
    opTitle(pullBtn, 'pull', S.t('pull'));
    opTitle(pushBtn, 'push', S.t('push'));
    opTitle(refreshBtn, 'refresh', S.t('refresh'));
  }

  /** 操作按钮 title：禁用原因（update 设置）> 排队中·位次 > 执行中 > 常规名 */
  function opTitle(btn: HTMLButtonElement, kind: string, normal: string): void {
    if (btn.disabled) return;
    const op = [...S.activeOps.values()].find(o => o.kind === kind);
    btn.title = op
      ? (op.queued ? S.t('opQueued', { n: op.position ?? 1 }) : S.t('opRunning'))
      : normal;
  }

  function flash(kind: string): void {
    const map: Record<string, HTMLButtonElement> = { fetch: fetchBtn, pull: pullBtn, push: pushBtn, refresh: refreshBtn };
    const b = map[kind];
    if (!b) return;
    b.classList.add('ok');
    setTimeout(() => b.classList.remove('ok'), 1200);
  }

  function syncFilterInputs(f: { authors: string[]; since: string; until: string }): void {
    const focusIn = authorBox.contains(document.activeElement)
      || document.activeElement === sinceInput
      || document.activeElement === untilInput;
    if (focusIn) return;   // 用户正在交互，不覆盖
    const incoming = new Set(f.authors);
    const same = incoming.size === sel.size && [...incoming].every(a => sel.has(a));
    if (!same) {
      sel.clear();
      for (const a of incoming) sel.add(a);
    }
    if (sinceInput.value !== f.since) sinceInput.value = f.since;
    if (untilInput.value !== f.until) untilInput.value = f.until;
    updateAuthorBtn();
    if (!authorPop.classList.contains('hidden')) renderAuthorList();
  }

  return { el: root, update, updateProgress, syncFilterInputs, flash };
}
