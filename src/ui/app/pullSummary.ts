/**
 * Pull/Fetch 摘要弹窗（v0.13 → Issue #51 表格化）：拉到的纯净提交（排除 merge）按
 * **作者 → 目录 → 文件** 三层呈现，叶子层文件条目以表格（文件 | 大小 | 修改时间 | 操作）
 * 四列对齐渲染，表头点击按列排序（各目录组内生效，目录分组不动）。
 * 历史回看（Issue #51）：宿主随事件下发最近 5 次摘要快照，弹窗顶部下拉可切换；
 * 命令面板「查看最近拉取摘要」直接弹窗（pullSummaryShow）。
 * 同作者同文件多提交合并取最新（×N 标记，悬停列出全部提交）。
 */
import { RENAME_SEP, type PullFileStatMap, type PullSummaryEntry, type PullSummaryHistoryItem } from '../../common/models';
import { setIcon, type IconName } from '../icons';
import { S, type App } from '../state';
import { baseOf, el, formatTime, groupPaths } from '../util';
import { openModal } from './overlays';

/** rename 条目 "旧 → 新" 取新路径；普通条目原样 */
const newPathOf = (f: string) => (f.includes(RENAME_SEP) ? f.split(RENAME_SEP)[1] : f);

const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${n} B`;

/** 表格排序列（file=文件名 localeCompare；size/time 按工作区 stat，缺失/已删排末尾） */
type SortKey = 'file' | 'size' | 'time';

export function showPullSummary(
  entries: PullSummaryEntry[],
  truncated: boolean,
  stat: PullFileStatMap,
  app: App,
  history?: PullSummaryHistoryItem[],
): void {
  // 历史条目（最新在前）；未携带（旧宿主/测试）时以本次为唯一条目
  const items: PullSummaryHistoryItem[] = history?.length
    ? history
    : [{ at: new Date().toISOString(), entries, truncated, stat }];
  let idx = 0;                       // 当前展示的历史条目（0 = 最新）
  let sortKey: SortKey = 'file';
  let sortDir: 1 | -1 = 1;

  const fmt = (iso: string) => formatTime(iso, S.config.dateFormat === 'iso' ? 'iso' : 'datetime', S.t);
  const { box, body, close } = openModal('');
  box.classList.add('gg-psum-modal');
  const titleEl = box.firstElementChild as HTMLElement;

  // 顶部工具行：历史下拉（多条目才有意义）+ 排序状态由表头承载
  const bar = el('div', 'gg-psum-bar');
  const histWrap = el('label', 'gg-psum-hist');
  const histSel = el('select', 'gg-psum-hist-sel') as HTMLSelectElement;
  const refreshHist = () => {
    histWrap.classList.toggle('hidden', items.length < 2);
    histSel.textContent = '';
    items.forEach((h, i) => {
      const opt = el('option', undefined, `${i === 0 ? S.t('pullHistoryLatest') : `#${i + 1}`} · ${fmt(h.at)} · ${h.entries.length}`) as HTMLOptionElement;
      opt.value = String(i);
      histSel.appendChild(opt);
    });
    histSel.value = String(idx);
  };
  histSel.addEventListener('change', () => {
    idx = Number(histSel.value) || 0;
    render();
  });
  histWrap.append(el('span', 'gg-psum-hist-label', S.t('pullHistoryLabel')), histSel);
  bar.appendChild(histWrap);

  const grid = el('div', 'gg-psum-table');
  const tableBox = el('div', 'gg-psum-list');

  /** 排序后的目录组内文件列表（组内排序，目录分组不受影响） */
  const sortFiles = (files: string[]): string[] => {
    const st = items[idx].stat;
    const arr = [...files];
    arr.sort((x, y) => {
      if (sortKey === 'file') return sortDir * newPathOf(x).localeCompare(newPathOf(y));
      const a = st?.[newPathOf(x)];
      const b = st?.[newPathOf(y)];
      // 缺失/已删除（null）恒排末尾，与方向无关
      if (!a || !b) return a === b ? 0 : a ? -1 : 1;
      const d = sortKey === 'size' ? a.size - b.size : Date.parse(a.mtime) - Date.parse(b.mtime);
      return sortDir * d;
    });
    return arr;
  };

  /** 表头：可点击排序（同列切换方向），当前排序列显示方向箭头 */
  function renderHead(): void {
    const head = el('div', 'gg-psum-thead');
    const mkHead = (key: SortKey, label: string): HTMLElement => {
      const h = el('div', 'gg-psum-th');
      const text = el('span', undefined, label);
      h.appendChild(text);
      if (sortKey === key) {
        h.classList.add('sorted');
        h.appendChild(el('span', 'gg-psum-sort-arrow', sortDir === 1 ? '↑' : '↓'));
      }
      h.title = S.t('pullSummarySortHint', { dir: S.t(sortDir === 1 ? 'pullSummarySortAsc' : 'pullSummarySortDesc') });
      h.addEventListener('click', () => {
        if (sortKey === key) sortDir = sortDir === 1 ? -1 : 1;
        else { sortKey = key; sortDir = 1; }
        render();
      });
      return h;
    };
    head.append(
      mkHead('file', S.t('pullSummaryColFile')),
      mkHead('size', S.t('pullSummaryColSize')),
      mkHead('time', S.t('pullSummaryColTime')),
      el('div', 'gg-psum-th'),
    );
    grid.appendChild(head);
  }

  function render(): void {
    const cur = items[idx];
    titleEl.textContent = S.t('pullSummaryTitle', { n: String(cur.entries.length) });
    refreshHist();
    grid.textContent = '';
    tableBox.textContent = '';
    renderHead();

    const { entries, truncated: trunc, stat } = cur;
    // 作者 → (文件 → 涉及提交)（entries 日期倒序：作者首现即其最新提交，作者块天然按最新在前）
    const byAuthor = new Map<string, { entries: PullSummaryEntry[]; files: Map<string, { latest: PullSummaryEntry; all: PullSummaryEntry[] }> }>();
    for (const e of entries) {
      let a = byAuthor.get(e.author);
      if (!a) { a = { entries: [], files: new Map() }; byAuthor.set(e.author, a); }
      a.entries.push(e);
      for (const f of e.files) {
        const c = a.files.get(f);
        if (c) c.all.push(e);
        else a.files.set(f, { latest: e, all: [e] });
      }
    }

    // 汇总行：提交 / 作者 / 文件（全局唯一）
    const uniqFiles = new Set(entries.flatMap(e => e.files.map(newPathOf)));
    grid.appendChild(fullRow('gg-psum-sum', S.t('pullSummaryCounts', {
      c: String(entries.length), a: String(byAuthor.size), f: String(uniqFiles.size),
    })));

    // Issue #29 P2：同批拉到的提交里后续又删除/移动的文件给出计数提示
    //（#31 起摘要仅在 Pull 合并完成触发，文件均已合并，缺失只剩"后续提交已删除"）
    const goneCount = [...uniqFiles].filter(p => stat?.[p] === null).length;
    if (goneCount > 0) {
      grid.appendChild(fullRow('gg-psum-note', S.t('pullSummaryGone', { n: String(goneCount) })));
    }

    const repoRoot = S.repos.find(r => r.id === S.repoId)?.root;

    for (const [author, a] of byAuthor) {
      const head = el('div', 'gg-psum-author');
      head.appendChild(el('span', 'gg-psum-author-name', author));
      head.appendChild(el('span', 'gg-psum-author-sub', S.t('pullSummaryAuthorCounts', {
        c: String(a.entries.length), f: String(a.files.size),
      })));
      grid.appendChild(head);

      // #49：无文件变更的提交（如 --allow-empty）也可见——作者块内直接列提交行（subject + 短SHA）
      if (!a.files.size) {
        for (const e of a.entries) {
          const row = el('div', 'gg-psum-row gg-psum-nofile');
          row.title = e.subject;
          row.append(
            el('span', 'gg-psum-name', e.subject),
            el('span', 'gg-psum-meta', e.shortSha),
          );
          grid.appendChild(row);
        }
        continue;
      }
      // 作者内目录分组（#46 收敛为 util.groupPaths：localeCompare、根目录置顶、根组显仓库绝对路径）
      for (const g of groupPaths([...a.files.keys()], f => newPathOf(f), repoRoot)) {
        const dirHead = el('div', 'gg-psum-dir', g.head);
        dirHead.title = g.head;   // 路径过长时省略号，悬停看全
        grid.appendChild(dirHead);
        for (const f of sortFiles(g.items)) {
          grid.appendChild(sumRow(f, a.files.get(f)!, stat, fmt, app));
        }
      }
    }

    if (entries.some(e => e.filesTruncated)) {
      grid.appendChild(fullRow('gg-psum-more', S.t('pullSummaryMoreFiles')));
    }
    if (trunc) {
      grid.appendChild(fullRow('gg-psum-more', S.t('pullSummaryTruncated', { n: String(entries.length) })));
    }
    tableBox.appendChild(grid);
  }

  /** 跨全宽行（汇总/作者/目录/提示）——grid-column 由 CSS 类统一 */
  function fullRow(cls: string, text: string): HTMLElement {
    return el('div', cls, text);
  }

  render();
  body.append(bar, tableBox);

  const btns = el('div', 'gg-modal-btns');
  const ok = el('button', 'gg-btn primary', S.t('close'));
  ok.addEventListener('click', close);
  btns.appendChild(ok);
  box.appendChild(btns);
  ok.focus();
}

/** 单个文件表格行：文件名 | 大小 | 修改时间（+×N）| 打开/定位按钮（作用于工作区新路径） */
function sumRow(
  f: string,
  info: { latest: PullSummaryEntry; all: PullSummaryEntry[] },
  stat: PullFileStatMap,
  fmt: (iso: string) => string,
  app: App,
): HTMLElement {
  const [oldP, newP] = f.includes(RENAME_SEP) ? f.split(RENAME_SEP) : [undefined, f];
  const nameText = oldP !== undefined ? `${baseOf(oldP)} → ${baseOf(newP)}` : baseOf(newP);
  const st = stat?.[newP];
  // Issue #29 三态：值=在工作区；null=已探测不在（同批后续提交已删除）→ 禁用行操作；
  // undefined=未采集（超宿主 stat 上限）→ 保持可点，点击后由宿主存在性探测兜底
  const gone = st === null;

  const row = el('div', 'gg-psum-row');
  if (gone) row.classList.add('gg-psum-gone');
  // 悬停：完整路径 + 涉及该文件的全部提交（时间 / 修改人 / 提交说明 / 短 SHA）+ 缺失提示
  const tip = [`${oldP !== undefined ? `${oldP} → ${newP}` : newP}`];
  if (!st) tip.push(S.t('pullSummaryFileGone'));
  tip.push(...info.all.map(e => `${fmt(e.date)}  ${e.author}  ${e.subject} (${e.shortSha})`));
  row.title = tip.join('\n');

  const name = el('span', 'gg-psum-name', nameText);   // 完整显示：不省略号，过长换行
  row.appendChild(name);
  const size = el('span', 'gg-psum-cell gg-psum-size', st ? fmtSize(st.size) : '—');
  const time = el('span', 'gg-psum-cell gg-psum-time');
  time.textContent = st ? fmt(st.mtime) : '—';
  if (info.all.length > 1) time.appendChild(el('span', 'gg-psum-n', ` ×${info.all.length}`));
  row.append(size, time);

  const acts = el('span', 'gg-psum-acts');
  const mkAct = (icon: IconName, title: string, run: () => void): HTMLButtonElement => {
    const b = el('button', 'gg-psum-act');
    setIcon(b, icon);
    b.title = title;
    b.addEventListener('click', ev => { ev.stopPropagation(); run(); });
    return b;
  };
  const openBtn = mkAct('goToFile', S.t('openFile'), () => app.openFile(newP));
  const revealBtn = mkAct('folder', S.t('revealInFM'), () => app.revealInFM(newP));
  if (gone) {
    for (const b of [openBtn, revealBtn]) {
      b.disabled = true;
      b.title = S.t('pullSummaryFileGone');
    }
  }
  acts.append(openBtn, revealBtn);
  row.appendChild(acts);
  return row;
}
