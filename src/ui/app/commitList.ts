/**
 * 提交图主区：虚拟滚动列表 + Canvas 线条层 + 列宽拖拽（持久化经 ui:saveColWidths）。
 * DOM 行节点恒定（可视行 + 缓冲 10），Canvas 只绘视口。
 */
import type { Commit } from '../../common/models';
import { rpc } from '../rpc';
import { S, type App } from '../state';
import { el, formatTime } from '../util';
import { GraphCanvas } from './graphCanvas';
import { showContextMenu, tagDialog } from './overlays';

export interface CommitList {
  el: HTMLElement;
  /** 仓库切换/过滤变化：重置滚动 */
  reset(): void;
  /** 提交数据变化（刷新但保留滚动位置） */
  refresh(): void;
  /** 追加一页 */
  appended(): void;
  /** 选中高亮变化（不动滚动） */
  selectionChanged(): void;
  /** 行高/列宽/语言等配置变化（列头与空态文案随 S.t 重建） */
  configChanged(): void;
  /** 视图切换（graph ⇄ pure：图形列在完整拓扑与窄时间线之间切换） */
  viewChanged(): void;
}

type ColKey = 'graph' | 'msg' | 'author' | 'sha';
const MIN_W: Record<ColKey, number> = { graph: 60, msg: 220, author: 70, sha: 60 };
const COL_LABELS: ColKey[] = ['graph', 'msg', 'author', 'sha'];

let measureCtx: CanvasRenderingContext2D | null = null;
/** 消息列 grid 地板（Issue #18 S1）：缺额挤压时 msg 最低保留宽，与 CSS minmax(var(--c-msg-min)) 联动 */
const MSG_FLOOR = 120;
/** 等宽字体下样例串实测宽（px，含单元格 16px 内边距，4px 网格取整）——时间列保底宽度的事实来源，
 *  杜绝字体/DPI/主题差异下的截断（Issue #18 S1）。 */
function measureTimeWidth(sample: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return Math.ceil((sample.length * 7 + 18) / 4) * 4;   // 极端环境兜底：等宽 ~7px/字符
  const family = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
  measureCtx.font = `12px ${family}`;
  return Math.ceil((measureCtx.measureText(sample).width + 18) / 4) * 4;
}

export function createCommitList(app: App): CommitList {
  const canvas = new GraphCanvas();
  const wrap = el('div', 'gg-list-wrap');
  const header = el('div', 'gg-list-header');
  const headCells: HTMLElement[] = [];
  const colKeys = ['colGraph', 'colMessage', 'colAuthor', 'colSha', 'colTime'];
  for (const key of colKeys) headCells.push(el('span', 'gg-col-h', S.t(key)));
  header.append(...headCells);

  const body = el('div', 'gg-list-body');
  const scroll = el('div', 'gg-list');
  scroll.tabIndex = 0;
  const sizer = el('div', 'gg-list-sizer');
  const footer = el('div', 'gg-list-footer');
  const loadbar = el('div', 'gg-loadbar');
  const loadbarInner = el('div', 'gg-loadbar-inner');
  loadbar.appendChild(loadbarInner);
  const empty = el('div', 'gg-empty');
  const emptySpinner = el('span', 'gg-spinner');
  emptySpinner.style.display = 'none';
  const emptyTitle = el('div', 'gg-empty-title', S.t('noCommits'));
  const emptyHint = el('div', 'gg-empty-hint', S.t('noCommitsHint'));
  empty.append(emptySpinner, emptyTitle, emptyHint);
  scroll.append(sizer, footer);
  body.append(scroll, canvas.canvas, empty);
  wrap.append(loadbar, header, body);
  canvas.attach(scroll);

  let pool: HTMLElement[] = [];
  let loadingMore = false;
  let lastGraph: unknown = undefined;
  let rafPending = false;
  const FOOTER_H = 36;

  /** 时间列降级状态（Issue #18 S1）：0=完整格式 / 1=紧凑 MM-DD HH:mm / 2=极窄兜底（60px ellipsis，完整值在 title） */
  let timeState = 0;
  let timeWidthCache = { key: '', full: 0, compact: 0 };
  /** 按 dateFormat/语言实测时间列需求宽（缓存，配置变化才重测） */
  function timeWidths(): { full: number; compact: number } {
    const key = `${S.config.dateFormat}|${S.lang}`;
    if (timeWidthCache.key !== key) {
      // relative 取最长样例（审查备注：分钟级文案比周/年更宽，临界宽度下防截断）
      const sample = S.config.dateFormat === 'relative'
        ? (S.lang === 'en' ? '51 minutes ago' : '51 分钟前')
        : '2026-09-05 23:59:59';
      timeWidthCache = { key, full: measureTimeWidth(sample), compact: measureTimeWidth('09-05 23:59') };
    }
    return timeWidthCache;
  }

  const rowHeight = () => S.config.rowHeightPx;
  const total = () => S.commits.length * rowHeight() + (S.commits.length ? FOOTER_H : 0);

  function applyWidths(): void {
    canvas.setPure(S.view === 'pure');   // 纯提交：Canvas 切时间线模式（固定窄列）
    canvas.setUserGraphWidth(S.colWidths.graph);
    const pure = S.view === 'pure';
    wrap.classList.toggle('pure', pure);
    // 表头首格保留占位（grid 五列固定）：pure 置空文案而非 display:none，防列错位
    headCells[0].firstChild!.textContent = pure ? '' : S.t('colGraph');
    wrap.style.setProperty('--c-graph', `${canvas.graphWidth}px`);
    wrap.style.setProperty('--c-msg', `${S.colWidths.msg}px`);
    wrap.style.setProperty('--c-author', `${S.colWidths.author}px`);
    wrap.style.setProperty('--c-sha', `${S.colWidths.sha}px`);
    // 时间列保底与降级（Issue #18 S1）：容量 = 列表内容宽 - graph - 各列 grid 地板（缺额时 grid 把
    // author/sha/msg 压回地板，按用户列宽预算会误判——实测扫描定论）；宽裕=完整格式、紧张=紧凑格式、
    // 极窄=60px ellipsis 兜底并同步下调 msg 下限防五列总和溢出容器。格式切换即失效行池缓存令 syncRows 重填。
    const w = timeWidths();
    const avail = scroll.clientWidth;
    const capacity = avail - canvas.graphWidth - MSG_FLOOR - MIN_W.author - MIN_W.sha;
    const next = avail === 0 ? 0 : capacity >= w.full ? 0 : capacity >= w.compact ? 1 : 2;
    if (next !== timeState) { timeState = next; invalidateRows(); }
    wrap.style.setProperty('--c-time-min', `${[w.full, w.compact, 60][timeState]}px`);
    const msgFloor = timeState === 2
      ? Math.max(80, avail - canvas.graphWidth - MIN_W.author - MIN_W.sha - 60)
      : MSG_FLOOR;
    wrap.style.setProperty('--c-msg-min', `${msgFloor}px`);
  }

  // 表头拖拽调宽（前四列右缘手柄；时间列自适应剩余空间）
  for (let i = 0; i < COL_LABELS.length; i++) {
    const col = COL_LABELS[i];
    const handle = el('div', 'gg-col-resizer');
    handle.title = '';
    headCells[i].appendChild(handle);
    handle.addEventListener('pointerdown', e => startResize(e, col));
  }

  function startResize(e: PointerEvent, col: ColKey): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = S.colWidths[col];
    const move = (ev: PointerEvent) => {
      const w = Math.max(MIN_W[col], Math.round(startW + ev.clientX - startX));
      if (w !== S.colWidths[col]) {
        S.colWidths[col] = w;
        applyWidths();
        scheduleSync();
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      void rpc('ui:saveColWidths', { widths: { ...S.colWidths } }).catch(() => undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function metrics(): void {
    if (S.graph && S.graph !== lastGraph) {
      lastGraph = S.graph;
      canvas.onGraphChanged(S.graph.laneCount, S.graph.curves);
    }
    applyWidths();
    sizer.style.height = `${total()}px`;
    // 空态（v0.14.7）：启动扫描 git / 仓库已发现但首页 log 在途 / 工作区无仓库 /
    // 既有两态（仓库无提交 | 筛选无结果）——启动全程有反馈，不再空白
    const scanning = S.reposPending;
    const loadingGit = !scanning && !S.state && S.repos.length > 0;
    const noRepo = !scanning && !S.state && S.repos.length === 0;
    // 顶部加载进度条（v0.15.1）：git 探测/首页历史在途时显示，完成即收起
    loadbar.classList.toggle('show', scanning || loadingGit);
    const showEmpty = (!!S.state && S.commits.length === 0) || scanning || loadingGit || noRepo;
    empty.classList.toggle('show', showEmpty);
    if (showEmpty) {
      let title: string;
      let hint: string | undefined;   // undefined = 隐藏副文案
      if (scanning) {
        title = S.t('loadingRepos');
      } else if (loadingGit) {
        title = S.t('loadingHistory');
      } else if (noRepo) {
        title = S.t('noRepos');
        hint = S.t('noReposHint');
      } else {
        // 区分"仓库无提交"与"筛选无结果"
        const filtered = !!(S.state?.filterRef || S.logFilter.authors.length || S.logFilter.since || S.logFilter.until);
        title = S.t(filtered ? 'noMatches' : 'noCommits');
        if (!filtered) hint = S.t('noCommitsHint');
      }
      if (emptyTitle.textContent !== title) emptyTitle.textContent = title;
      if (hint) {
        if (emptyHint.textContent !== hint) emptyHint.textContent = hint;
        emptyHint.classList.remove('hidden');
      } else {
        emptyHint.classList.add('hidden');
      }
      emptySpinner.style.display = (scanning || loadingGit) ? '' : 'none';
    }
  }

  function makeRow(): HTMLElement {
    const row = el('div', 'gg-row');
    const graphCell = el('span', 'gg-cell graph');
    const msg = el('span', 'gg-cell msg');
    const author = el('span', 'gg-cell author');
    const sha = el('span', 'gg-cell sha');
    const time = el('span', 'gg-cell time');
    row.append(graphCell, msg, author, sha, time);
    row.addEventListener('click', () => {
      // 用行上记录的 sha，而不是池化索引——避免刷新替换数组后的索引错位竞态
      const sha2 = row.dataset.sha;
      if (sha2) app.selectCommit(sha2);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const sha2 = row.dataset.sha;
      const c = sha2 ? S.commits.find(x => x.sha === sha2) : undefined;
      if (c) commitMenu(c, e.clientX, e.clientY);
    });
    return row;
  }

  function fill(row: HTMLElement, idx: number): void {
    const c = S.commits[idx];
    (row as any)._idx = idx;
    row.dataset.sha = c.sha;
    row.classList.toggle('selected', c.sha === S.selectedSha);
    const cells = row.children;
    const msg = cells[1] as HTMLElement;
    msg.textContent = '';
    msg.appendChild(el('span', 'gg-subject', c.subject));
    for (const chip of buildChips(c)) msg.appendChild(chip);
    (cells[2] as HTMLElement).textContent = c.author.name;
    (cells[2] as HTMLElement).title = c.author.email;
    (cells[3] as HTMLElement).textContent = c.shortSha;
    (cells[4] as HTMLElement).textContent = formatTime(c.author.date, timeState === 0 ? S.config.dateFormat : 'compact', S.t);
    (cells[4] as HTMLElement).title = formatTime(c.author.date, 'datetime', S.t);
  }

  function buildChips(c: Commit): HTMLElement[] {
    const out: HTMLElement[] = [];
    let tagTotal = 0;
    for (const ref of c.refs) if (ref.kind === 'tag') tagTotal++;
    let shownTags = 0;
    for (const ref of c.refs) {
      if (ref.kind === 'remote' && !S.config.showRemoteChips) continue;
      if (ref.kind === 'tag') {
        shownTags++;
        if (shownTags > S.config.maxTagChips) continue;
      }
      const text = ref.isHead && ref.name !== 'HEAD' ? `HEAD → ${ref.name}` : ref.name;
      out.push(el('span', `gg-chip ${ref.kind}`, text));
    }
    if (tagTotal > S.config.maxTagChips) {
      out.push(el('span', 'gg-chip tag', `+${tagTotal - S.config.maxTagChips}`));
    }
    return out;
  }

  function commitMenu(c: Commit, x: number, y: number): void {
    showContextMenu([
      { label: S.t('checkoutDetached'), run: () => app.checkoutDetached(c.sha) },
      { label: S.t('resetToThisCommit'), run: () => app.resetTo(c.sha) },
      { sep: true },
      { label: S.t('newTag'), run: () => {
        void tagDialog(c.shortSha, S.t).then(r => {
          if (r) app.tagCreate(r.name, c.sha, r.message || undefined);
        });
      } },
      { sep: true },
      { label: S.t('copySha'), run: () => app.copy(c.sha) },
      { label: S.t('copySubject'), run: () => app.copy(c.subject) },
    ], x, y);
  }

  function syncRows(): void {
    rafPending = false;
    metrics();
    const R = rowHeight();
    const st = scroll.scrollTop;
    const vh = scroll.clientHeight;
    const n = S.commits.length;
    if (n === 0) {
      for (const r of pool) { r.style.display = 'none'; (r as any)._idx = -1; delete r.dataset.sha; }
      canvas.redraw();
      return;
    }
    const firstB = Math.max(0, Math.floor(st / R) - 10);
    const lastB = Math.min(n - 1, Math.ceil((st + vh) / R) + 10);
    const need = lastB - firstB + 1;
    while (pool.length < need) {
      const row = makeRow();
      pool.push(row);
      scroll.appendChild(row);
    }
    for (let i = 0; i < pool.length; i++) {
      const row = pool[i];
      if (i >= need) {
        // 按 display 现状判断而非 _idx：invalidateRows()（每次 refresh）只清 _idx 不隐藏行，
        // 若以 _idx!==-1 为守卫，筛选等使列表收缩的刷新后 surplus 陈旧行将永不被隐藏（Issue #5）
        if (row.style.display !== 'none') { row.style.display = 'none'; (row as any)._idx = -1; delete row.dataset.sha; }
        continue;
      }
      const idx = firstB + i;
      row.style.display = '';
      row.style.height = `${R}px`;
      row.style.transform = `translateY(${idx * R}px)`;
      if ((row as any)._idx !== idx) fill(row, idx);
      else row.classList.toggle('selected', row.dataset.sha === S.selectedSha);
    }

    footer.style.transform = `translateY(${n * R}px)`;
    footer.style.height = `${FOOTER_H}px`;
    footer.textContent = '';
    if (loadingMore) {
      footer.appendChild(el('span', 'gg-spinner'));
      footer.appendChild(el('span', undefined, S.t('loading')));
    } else if (S.state?.hasMore && n >= S.config.maxAutoLoad) {
      const btn = el('button', 'gg-btn small', S.t('loadMore'));
      btn.addEventListener('click', () => {
        if (!loadingMore) { loadingMore = true; app.loadMore(); syncRows(); }
      });
      footer.appendChild(btn);
    } else if (S.state && !S.state.hasMore && n > 20) {
      footer.appendChild(el('span', 'gg-footer-count', S.t('loadedCount', { n })));
    }

    if (!loadingMore && S.state?.hasMore && lastB >= n - 8 && n < S.config.maxAutoLoad) {
      loadingMore = true;
      app.loadMore();
    }
    canvas.redraw();
  }

  function scheduleSync(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(syncRows);
  }

  scroll.addEventListener('scroll', scheduleSync);
  new ResizeObserver(scheduleSync).observe(scroll);

  scroll.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const n = S.commits.length;
    if (!n) return;
    let idx = S.commits.findIndex(c => c.sha === S.selectedSha);
    idx = idx === -1 ? 0 : Math.max(0, Math.min(n - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)));
    const sha = S.commits[idx].sha;
    app.selectCommit(sha);
    const y = idx * rowHeight();
    if (y < scroll.scrollTop) scroll.scrollTop = y;
    else if (y + rowHeight() > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = y + rowHeight() - scroll.clientHeight;
    }
  });

  function refreshCommon(): void {
    scheduleSync();
  }

  /**
   * 失效行池内容缓存：syncRows 以 _idx 判定是否重填，但 repoState 会整体替换
   * S.commits 数组（新提交插在顶部）——位置相同内容已变，不清 _idx 顶行将
   * 永远显示旧数据（idx 恒 0，滚动也无法使其错位重填），表现为"提交后列表不刷新"。
   */
  function invalidateRows(): void {
    for (const r of pool) { (r as any)._idx = -1; delete r.dataset.sha; }
  }

  return {
    el: wrap,
    reset() { scroll.scrollTop = 0; loadingMore = false; invalidateRows(); refreshCommon(); },
    refresh() { loadingMore = false; invalidateRows(); refreshCommon(); },
    appended() { loadingMore = false; refreshCommon(); },
    selectionChanged() {
      for (const row of pool) {
        row.classList.toggle('selected', row.dataset.sha === S.selectedSha);
      }
      canvas.redraw();
    },
    viewChanged() {
      lastGraph = undefined;
      refreshCommon();
    },
    configChanged() {
      lastGraph = undefined;
      // 审查 P2-2：dateFormat/语言切换改变行内时间文本（同档换格式不触发三态机失效）——强制重填可视行
      invalidateRows();
      for (let i = 0; i < colKeys.length; i++) {
        headCells[i].firstChild!.textContent = S.t(colKeys[i]);
      }
      emptyTitle.textContent = S.t('noCommits');
      emptyHint.textContent = S.t('noCommitsHint');
      refreshCommon();
    },
  };
}
