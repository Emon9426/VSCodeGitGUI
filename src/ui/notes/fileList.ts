/**
 * 笔记文件列表（v0.15.0 左栏）：目录头（路径 + 更改/定位）、搜索、图标/列表双视图、
 * 新建/重命名/删除。搜索为纯前端过滤（notesStore.filterNotes 同语义在宿主，此处本地过滤即可）。
 */
import type { NoteMeta } from '../../common/notesProtocol';
import { el, clearChildren } from '../util';

export interface NotesFileListHost {
  create(): void;
  open(id: string): void;
  rename(id: string, title: string): void;
  remove(id: string): void;
  pickDir(): void;
  revealFM(): void;
  /** 右键/长按菜单（宿主注入，展示 VS Code 式菜单浮层） */
  contextMenu(x: number, y: number, note: NoteMeta | undefined): void;
}

export interface NotesFileList {
  el: HTMLElement;
  setDir(dir: string): void;
  setNotes(notes: NoteMeta[]): void;
  setActive(id: string | undefined): void;
}

export function createFileList(t: (k: string, p?: Record<string, string | number>) => string, host: NotesFileListHost): NotesFileList {
  const root = el('div', 'n-side');

  const head = el('div', 'n-side-head');
  const headTitle = el('span', undefined, '快速笔记');
  const headActs = el('span', 'n-side-acts');
  const dirBtn = el('button', 'mini-btn', '📂') as HTMLButtonElement;
  dirBtn.title = t('notesChangeDir');
  const fmBtn = el('button', 'mini-btn', '↗') as HTMLButtonElement;
  fmBtn.title = t('notesRevealFM');
  headActs.append(dirBtn, fmBtn);
  head.append(headTitle, headActs);

  const dirRow = el('div', 'n-dir');
  const dirText = el('span', 'n-dir-text');
  const dirLink = el('a', undefined, t('notesChangeDir')) as HTMLAnchorElement;
  dirLink.addEventListener('click', e => { e.preventDefault(); host.pickDir(); });
  dirRow.append(dirText, dirLink);
  dirBtn.addEventListener('click', () => host.pickDir());
  fmBtn.addEventListener('click', () => host.revealFM());

  const search = el('input', 'n-search') as HTMLInputElement;
  search.placeholder = t('notesSearch');
  search.addEventListener('keydown', e => { if (e.key === 'Escape') { search.value = ''; render(); } e.stopPropagation(); });
  search.addEventListener('input', () => render());

  const viewRow = el('div', 'n-view-toggle');
  const gridBtn = el('button', 'pv-mini on', '▤') as HTMLButtonElement;
  gridBtn.title = t('notesGrid');
  const listBtn = el('button', 'pv-mini', '☰') as HTMLButtonElement;
  listBtn.title = t('notesList');
  const newBtn = el('button', 'pv-mini new', '＋ ' + t('notesNew')) as HTMLButtonElement;
  viewRow.append(gridBtn, listBtn, newBtn);

  let view: 'grid' | 'list' = 'grid';
  const setView = (v: 'grid' | 'list'): void => {
    view = v;
    gridBtn.classList.toggle('on', v === 'grid');
    listBtn.classList.toggle('on', v === 'list');
    listEl.classList.toggle('grid', v === 'grid');
  };
  gridBtn.addEventListener('click', () => setView('grid'));
  listBtn.addEventListener('click', () => setView('list'));
  newBtn.addEventListener('click', () => host.create());

  const listEl = el('div', 'n-list grid');
  let notes: NoteMeta[] = [];
  let activeId: string | undefined;

  const fmtTime = (ms: number): string => {
    const d = new Date(ms);
    const p = (n: number): string => String(n).padStart(2, '0');
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
      ? `${p(d.getHours())}:${p(d.getMinutes())}`
      : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  function render(): void {
    const q = search.value.trim().toLowerCase();
    clearChildren(listEl);
    const shown = notes.filter(n => !q || n.title.toLowerCase().includes(q));
    for (const n of shown) {
      const item = el('div', `n-item${n.id === activeId ? ' on' : ''}`);
      // v0.17：emoji 在部分 webview 环境渲染为破损占位符，改用受控内联 SVG
      const ico = el('span', 'n-ico');
      ico.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 1.5h6.2L13 5.2V14a1.5 1.5 0 0 1-1.5 1.5h-8.5A1.5 1.5 0 0 1 1.5 14V3A1.5 1.5 0 0 1 3 1.5z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M9 1.8V5.5h3.8" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 8.5h7M4 11h5" stroke="currentColor" stroke-width="1.2"/></svg>';
      item.append(ico, el('span', 'n-t', n.title), el('span', 'n-d', fmtTime(n.updated)));
      item.title = n.title;
      item.addEventListener('click', () => host.open(n.id));
      item.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
        host.contextMenu(e.clientX, e.clientY, n);
      });
      listEl.appendChild(item);
    }
    if (!shown.length) listEl.appendChild(el('div', 'n-empty', q ? '' : t('notesEmptyList')));
  }

  root.append(head, dirRow, search, viewRow, listEl);
  return {
    el: root,
    setDir(dir: string) { dirText.textContent = dir; dirText.title = dir; },
    setNotes(next: NoteMeta[]) { notes = next; render(); },
    setActive(id: string | undefined) { activeId = id; render(); },
  };
}
