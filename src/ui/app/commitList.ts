/**
 * 提交图主区：虚拟滚动列表 + Canvas 线条层（设计方案 5.3）。
 * DOM 行节点恒定（可视行 + 缓冲 10），Canvas 只绘视口。
 */
import type { Commit } from '../../common/models';
import { S, type App } from '../state';
import { el, formatTime } from '../util';
import { GraphCanvas } from './graphCanvas';
import { showContextMenu } from './overlays';

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
  /** 行高/列宽等配置变化 */
  configChanged(): void;
}

export function createCommitList(app: App): CommitList {
  const canvas = new GraphCanvas();
  const wrap = el('div', 'gg-list-wrap');
  const header = el('div', 'gg-list-header');
  for (const key of ['colGraph', 'colMessage', 'colAuthor', 'colSha', 'colTime']) {
    header.appendChild(el('span', 'gg-col-h', S.t(key)));
  }
  const body = el('div', 'gg-list-body');
  const scroll = el('div', 'gg-list');
  scroll.tabIndex = 0;
  const sizer = el('div', 'gg-list-sizer');
  const footer = el('div', 'gg-list-footer');
  const empty = el('div', 'gg-empty');
  empty.appendChild(el('div', 'gg-empty-title', S.t('noCommits')));
  empty.appendChild(el('div', 'gg-empty-hint', S.t('noCommitsHint')));
  scroll.append(sizer, footer);
  body.append(scroll, canvas.canvas, empty);
  wrap.append(header, body);
  canvas.attach(scroll);

  let pool: HTMLElement[] = [];
  let loadingMore = false;
  let lastGraph: unknown = undefined;
  let rafPending = false;
  const FOOTER_H = 36;

  const rowHeight = () => S.config.rowHeightPx;
  const total = () => S.commits.length * rowHeight() + (S.commits.length ? FOOTER_H : 0);

  function metrics(): void {
    if (S.graph && S.graph !== lastGraph) {
      lastGraph = S.graph;
      canvas.onGraphChanged(S.graph.laneCount, S.graph.curves);
    }
    wrap.style.setProperty('--graphW', `${canvas.graphWidth}px`);
    sizer.style.height = `${total()}px`;
    const showEmpty = !!S.state && S.commits.length === 0;
    empty.classList.toggle('show', showEmpty);
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
      const idx = (row as any)._idx;
      if (typeof idx === 'number' && S.commits[idx]) app.selectCommit(S.commits[idx].sha);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const idx = (row as any)._idx;
      const c = typeof idx === 'number' ? S.commits[idx] : undefined;
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
    (cells[4] as HTMLElement).textContent = formatTime(c.author.date, S.config.dateFormat, S.t);
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
      for (const r of pool) { r.style.display = 'none'; (r as any)._idx = -1; }
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
        if ((row as any)._idx !== -1) { row.style.display = 'none'; (row as any)._idx = -1; }
        continue;
      }
      const idx = firstB + i;
      row.style.display = '';
      row.style.height = `${R}px`;
      row.style.transform = `translateY(${idx * R}px)`;
      if ((row as any)._idx !== idx) fill(row, idx);
    }

    // 页脚：加载中 spinner / 达到上限后的手动加载按钮
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

    // 自动加载更多
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

  return {
    el: wrap,
    reset() { scroll.scrollTop = 0; loadingMore = false; refreshCommon(); },
    refresh() { loadingMore = false; refreshCommon(); },
    appended() { loadingMore = false; refreshCommon(); },
    selectionChanged() {
      for (const row of pool) {
        const idx = (row as any)._idx;
        if (typeof idx === 'number' && idx >= 0) {
          row.classList.toggle('selected', S.commits[idx]?.sha === S.selectedSha);
        }
      }
      canvas.redraw();
    },
    configChanged() { lastGraph = undefined; refreshCommon(); },
  };
}
