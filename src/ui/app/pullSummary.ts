/**
 * Pull/Fetch 摘要弹窗（v0.13）：拉到的纯净提交（排除 merge）按
 * **作者 → 目录 → 文件** 三层呈现：作者头汇总其提交/文件数，目录头显示相对路径一次，
 * 组内只列文件名 + 工作区大小/修改时间，行尾按钮一键打开文件或在资源管理器中定位。
 * 同作者同文件多提交合并取最新（×N 标记，悬停列出全部提交）。
 */
import { RENAME_SEP, type PullFileStat, type PullSummaryEntry } from '../../common/models';
import { setIcon, type IconName } from '../icons';
import { S, type App } from '../state';
import { el, formatTime } from '../util';
import { openModal } from './overlays';

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
/** rename 条目 "旧 → 新" 取新路径；普通条目原样 */
const newPathOf = (f: string) => (f.includes(RENAME_SEP) ? f.split(RENAME_SEP)[1] : f);

const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB`
  : n >= 1024 ? `${(n / 1024).toFixed(1)} KB`
  : `${n} B`;

export function showPullSummary(
  kind: 'pull' | 'fetch',
  entries: PullSummaryEntry[],
  truncated: boolean,
  stat: Record<string, PullFileStat>,
  app: App,
): void {
  const title = S.t(kind === 'pull' ? 'pullSummaryTitle' : 'fetchSummaryTitle', { n: String(entries.length) });
  const { box, body, close } = openModal(title);
  box.classList.add('gg-psum-modal');

  const fmt = (iso: string) => formatTime(iso, S.config.dateFormat === 'iso' ? 'iso' : 'datetime', S.t);

  // 作者 → (文件 → 涉及提交)（entries 日期倒序：作者首现即其最新提交，作者块天然按最新在前）
  const byAuthor = new Map<string, { entries: PullSummaryEntry[]; files: Map<string, { latest: PullSummaryEntry; all: PullSummaryEntry[] }> }>();
  for (const e of entries) {
    let a = byAuthor.get(e.author);
    if (!a) { a = { entries: [], files: new Map() }; byAuthor.set(e.author, a); }
    a.entries.push(e);
    for (const f of e.files) {
      const cur = a.files.get(f);
      if (cur) cur.all.push(e);
      else a.files.set(f, { latest: e, all: [e] });
    }
  }

  // 汇总行：提交 / 作者 / 文件（全局唯一）
  const uniqFiles = new Set(entries.flatMap(e => e.files.map(newPathOf)));
  body.appendChild(el('div', 'gg-psum-sum', S.t('pullSummaryCounts', {
    c: String(entries.length), a: String(byAuthor.size), f: String(uniqFiles.size),
  })));

  const repoRoot = S.repos.find(r => r.id === S.repoId)?.root;
  const listBox = el('div', 'gg-psum-list');

  for (const [author, a] of byAuthor) {
    const head = el('div', 'gg-psum-author');
    head.appendChild(el('span', 'gg-psum-author-name', author));
    head.appendChild(el('span', 'gg-psum-author-sub', S.t('pullSummaryAuthorCounts', {
      c: String(a.entries.length), f: String(a.files.size),
    })));
    listBox.appendChild(head);

    // 作者内目录分组（与工作副本 appendGrouped 同语义：localeCompare、根目录置顶）
    const dirs = new Map<string, string[]>();
    for (const f of a.files.keys()) dirs.set(dirOf(newPathOf(f)), [...(dirs.get(dirOf(newPathOf(f))) ?? []), f]);
    const sortedDirs = [...dirs.keys()].sort((x, y) => (x === '' ? -1 : y === '' ? 1 : x.localeCompare(y)));

    for (const d of sortedDirs) {
      const headText = d === '' ? (repoRoot ?? '/') : d;
      const dirHead = el('div', 'gg-psum-dir', headText);
      dirHead.title = headText;   // 路径过长时省略号，悬停看全
      listBox.appendChild(dirHead);
      for (const f of (dirs.get(d) ?? []).sort((x, y) => newPathOf(x).localeCompare(newPathOf(y)))) {
        listBox.appendChild(sumRow(f, a.files.get(f)!, stat, fmt, app));
      }
    }
  }

  if (entries.some(e => e.filesTruncated)) {
    listBox.appendChild(el('div', 'gg-psum-more', S.t('pullSummaryMoreFiles')));
  }
  if (truncated) {
    listBox.appendChild(el('div', 'gg-psum-more', S.t('pullSummaryTruncated', { n: String(entries.length) })));
  }
  body.appendChild(listBox);

  const btns = el('div', 'gg-modal-btns');
  const ok = el('button', 'gg-btn primary', S.t('close'));
  ok.addEventListener('click', close);
  btns.appendChild(ok);
  box.appendChild(btns);
  ok.focus();
}

/** 单个文件行：文件名 | 大小 | 修改时间 | ×N | 打开/定位按钮（作用于工作区新路径） */
function sumRow(
  f: string,
  info: { latest: PullSummaryEntry; all: PullSummaryEntry[] },
  stat: Record<string, PullFileStat>,
  fmt: (iso: string) => string,
  app: App,
): HTMLElement {
  const [oldP, newP] = f.includes(RENAME_SEP) ? f.split(RENAME_SEP) : [undefined, f];
  const nameText = oldP !== undefined ? `${base(oldP)} → ${base(newP)}` : base(newP);
  const st = stat?.[newP];   // 无条目 = 文件不在工作区（大小/时间显示 —，按钮仍可用：宿主侧有回退）

  const row = el('div', 'gg-psum-row');
  // 悬停：完整路径 + 涉及该文件的全部提交（时间 / 修改人 / 提交说明 / 短 SHA）+ 缺失提示
  const tip = [`${oldP !== undefined ? `${oldP} → ${newP}` : newP}`];
  if (!st) tip.push(S.t('pullSummaryFileGone'));
  tip.push(...info.all.map(e => `${fmt(e.date)}  ${e.author}  ${e.subject} (${e.shortSha})`));
  row.title = tip.join('\n');

  row.appendChild(el('span', 'gg-psum-name', nameText));   // 完整显示：不省略号，过长换行
  const meta = el('span', 'gg-psum-meta');
  meta.appendChild(el('span', 'gg-psum-size', st ? fmtSize(st.size) : '—'));
  meta.appendChild(el('span', 'gg-psum-time', st ? fmt(st.mtime) : '—'));
  if (info.all.length > 1) meta.appendChild(el('span', 'gg-psum-n', `×${info.all.length}`));
  row.appendChild(meta);

  const acts = el('span', 'gg-psum-acts');
  const mkAct = (icon: IconName, title: string, run: () => void): HTMLElement => {
    const b = el('button', 'gg-psum-act');
    setIcon(b, icon);
    b.title = title;
    b.addEventListener('click', ev => { ev.stopPropagation(); run(); });
    return b;
  };
  acts.append(
    mkAct('goToFile', S.t('openFile'), () => app.openFile(newP)),
    mkAct('folder', S.t('revealInFM'), () => app.revealInFM(newP)),
  );
  row.appendChild(acts);
  return row;
}
