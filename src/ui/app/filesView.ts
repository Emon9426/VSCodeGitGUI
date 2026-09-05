/**
 * 文件历史页 · 左区资源管理器（v0.14）：
 * 地址栏（面包屑 ⇄ 编辑态：路径导航 / 文件定位打开）+ 命令条（删除/移动/重命名/复制路径 + 过滤）
 * + 详细信息视图（四列表格/列宽拖拽记忆）与文件夹视图（平铺网格）双形态
 * + 多选（Ctrl/Shift）+ 面板宽度拖拽记忆。
 * 选中为纯色高亮，行内不绘制任何竖线/虚线（五审定稿）。
 */
import type { FileItem } from '../../common/models';
import { S, type App } from '../state';
import { el, formatDateTime } from '../util';
import { rpc } from '../rpc';
import { fileTypeInfo, fileIconSvg } from '../icons';
import { showContextMenu, toast } from './overlays';

type SortKey = 'name' | 'date' | 'type' | 'size';

export function createFilesView(app: App, hooks?: { onSelection?: () => void }) {
  const root = el('div', 'gg-files');
  root.style.width = S.files.paneW + 'px';

  // ---------- 头部：标题 + 视图切换 ----------
  const head = el('div', 'gg-files-head');
  head.append(el('span', 'gg-files-title', S.t('filesTitle')));
  const vsw = el('span', 'gg-files-vsw');
  const bTile = el('button', 'gg-files-vbtn') as HTMLButtonElement;
  bTile.title = S.t('filesViewTile');
  bTile.textContent = '▦';
  const bDet = el('button', 'gg-files-vbtn') as HTMLButtonElement;
  bDet.title = S.t('filesViewDet');
  bDet.textContent = '☰';
  bTile.addEventListener('click', () => { S.files.view = 'tile'; update(); });
  bDet.addEventListener('click', () => { S.files.view = 'det'; update(); });
  vsw.append(bTile, bDet);
  head.append(vsw);
  root.append(head);

  // ---------- 地址栏：面包屑 ⇄ 编辑态 ----------
  const addr = el('div', 'gg-files-addr');
  const addrIco = el('span', 'gg-files-addr-ico', '🗂');
  const crumbs = el('span', 'gg-files-crumbs');
  const addrSpace = el('span', 'gg-files-addr-space');
  const bEdit = el('button', 'gg-files-abtn') as HTMLButtonElement;
  bEdit.title = S.t('filesAddrEdit') + ' (Ctrl+L)';
  bEdit.textContent = '✎';
  const bCopyAddr = el('button', 'gg-files-abtn') as HTMLButtonElement;
  bCopyAddr.title = S.t('copyPath');
  bCopyAddr.textContent = '⧉';
  const addrInput = document.createElement('input');
  addrInput.className = 'gg-files-addr-input';
  addrInput.placeholder = S.t('filesAddrPh');
  addrInput.style.display = 'none';
  addr.append(addrIco, crumbs, addrSpace, bEdit, bCopyAddr, addrInput);
  addrSpace.addEventListener('click', addrEdit);
  bEdit.addEventListener('click', addrEdit);
  bCopyAddr.addEventListener('click', () => app.copy(S.files.cwd || '/'));
  addrInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { addrGo(addrInput.value); }
    if (e.key === 'Escape') { addrCancel(); }
  });
  root.append(addr);

  // ---------- 命令条：删除 / 移动 / 重命名 / 复制 + 过滤 ----------
  const cmdbar = el('div', 'gg-files-cmdbar');
  const bDel = el('button', 'gg-files-cbtn danger') as HTMLButtonElement;
  bDel.textContent = '🗑 ' + S.t('filesDelete');
  bDel.title = 'Del';
  const bMove = el('button', 'gg-files-cbtn') as HTMLButtonElement;
  bMove.textContent = '✂ ' + S.t('filesMove');
  const bRen = el('button', 'gg-files-cbtn') as HTMLButtonElement;
  bRen.textContent = '🗎 ' + S.t('filesRename');
  bRen.title = 'F2';
  const bCopy = el('button', 'gg-files-cbtn') as HTMLButtonElement;
  bCopy.textContent = '⧉ ' + S.t('copyPath');
  const flt = el('span', 'gg-files-flt');
  flt.textContent = '🔍';
  const fltInput = document.createElement('input');
  fltInput.placeholder = S.t('filesFilterPh');
  fltInput.addEventListener('input', () => { S.files.filter = fltInput.value; renderList(); });
  flt.append(fltInput);
  cmdbar.append(bDel, bMove, bRen, bCopy, el('span', 'gg-files-cmdsp'), flt);
  root.append(cmdbar);
  bDel.addEventListener('click', () => { if (S.files.sel.length && !fileOpBusy()) app.folderDelete([...S.files.sel]); });
  bMove.addEventListener('click', () => { if (S.files.sel.length && !fileOpBusy()) app.folderMove([...S.files.sel]); });
  bRen.addEventListener('click', () => { if (S.files.sel.length === 1 && !fileOpBusy()) app.folderRename(S.files.sel[0]); });
  bCopy.addEventListener('click', () => { if (S.files.sel.length) app.copy(S.files.sel.join('\n')); });

  // ---------- 列表区 ----------
  const list = el('div', 'gg-files-list');
  root.append(list);

  // 排序状态（组件内）
  let sortKey: SortKey = 'name';
  let sortAsc = true;

  // ---------- 渲染 ----------
  /** B6（Issue #18）：文件命令（本地道串行）在途 → 禁用防重复入队/撞锁 */
  const FILE_OP_KINDS = new Set(['moveFolder', 'renamePath', 'deletePaths']);
  const fileOpBusy = (): boolean => [...S.activeOps.values()].some(o => FILE_OP_KINDS.has(o.kind));

  function update(): void {
    bTile.classList.toggle('on', S.files.view === 'tile');
    bDet.classList.toggle('on', S.files.view === 'det');
    const busy = fileOpBusy();
    bDel.classList.toggle('dis', !S.files.sel.length || busy);
    bMove.classList.toggle('dis', !S.files.sel.length || busy);
    bRen.classList.toggle('dis', S.files.sel.length !== 1 || busy);
    bCopy.classList.toggle('dis', !S.files.sel.length);
    bDel.title = busy ? S.t('filesOpBusy') : 'Del';
    bMove.title = busy ? S.t('filesOpBusy') : '';
    bRen.title = busy ? S.t('filesOpBusy') : 'F2';
    renderCrumbs();
    renderList();
  }

  function renderCrumbs(): void {
    crumbs.textContent = '';
    const mk = (label: string, p: string, cur?: boolean) => {
      const c = el('span', 'gg-files-crumb' + (cur ? ' cur' : ''), label);
      c.addEventListener('click', () => app.filesNavigate(p));
      return c;
    };
    crumbs.append(mk('🏠', '', S.files.cwd === ''));
    let acc = '';
    for (const seg of S.files.cwd ? S.files.cwd.split('/') : []) {
      acc = acc ? acc + '/' + seg : seg;
      crumbs.append(el('span', 'gg-files-crumb-sep', '›'), mk(seg, acc, acc === S.files.cwd));
    }
  }

  function sortedItems(): FileItem[] {
    const f = S.files.filter.trim().toLowerCase();
    const arr = S.files.items.filter(x => !f || x.name.toLowerCase().includes(f));
    const cmp: Record<SortKey, (a: FileItem, b: FileItem) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
      date: (a, b) => (a.mtime ?? '').localeCompare(b.mtime ?? ''),
      type: (a, b) => fileTypeInfo(a.name).type.localeCompare(fileTypeInfo(b.name).type) || a.name.localeCompare(b.name),
      size: (a, b) => (a.size ?? a.gitSize ?? -1) - (b.size ?? b.gitSize ?? -1),
    };
    const sign = sortAsc ? 1 : -1;
    return [...arr].sort((a, b) => (Number(b.isDir) - Number(a.isDir)) || sign * cmp[sortKey](a, b));
  }

  function fmtSize(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  function renderList(): void {
    list.textContent = '';
    const items = sortedItems();
    if (!items.length) {
      list.append(el('div', 'gg-files-empty', S.files.filter ? S.t('filesFilterNone') : S.t('filesEmptyDir')));
      return;
    }
    if (S.files.view === 'det') renderDet(items);
    else renderTile(items);
  }

  function bindRow(node: HTMLElement, it: FileItem): void {
    node.addEventListener('click', e => {
      const multi = e.ctrlKey || e.metaKey;
      const range = e.shiftKey && S.files.anchor;
      if (multi) {
        const i = S.files.sel.indexOf(it.path);
        if (i >= 0) S.files.sel.splice(i, 1);
        else S.files.sel.push(it.path);
        S.files.anchor = it.path;
      } else if (range) {
        const arr = S.files.items.map(x => x.path);
        const a = arr.indexOf(S.files.anchor!);
        const b = arr.indexOf(it.path);
        if (a >= 0 && b >= 0) S.files.sel = arr.slice(Math.min(a, b), Math.max(a, b) + 1);
      } else {
        S.files.sel = [it.path];
        S.files.anchor = it.path;
        app.filesSelect(it.path, it.isDir);
      }
      update();                  // 刷新列表 + 命令条按钮禁用态（选中变化必须反映到按钮）
      hooks?.onSelection?.();   // 联动右区（单选走 filesSelect 已含）
    });
    node.addEventListener('dblclick', () => {
      if (it.isDir) app.filesNavigate(it.path);
      else app.openFile(it.path);
    });
    node.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!S.files.sel.includes(it.path)) {
        S.files.sel = [it.path];
        S.files.anchor = it.path;
        app.filesSelect(it.path, it.isDir);
        renderList();
        hooks?.onSelection?.();
      }
      showContextMenu([
        { label: S.t('filesOpen'), run: () => (it.isDir ? app.filesNavigate(it.path) : app.openFile(it.path)) },
        { label: S.t('filesViewHist'), run: () => app.filesSelect(it.path, it.isDir) },
        { label: S.t('filesRename'), run: () => app.folderRename(it.path) },
        { label: S.t('filesMove'), run: () => app.folderMove([it.path]) },
        { label: S.t('filesDelete'), danger: true, run: () => app.folderDelete([it.path]) },
        { sep: true },
        { label: S.t('copyPath'), run: () => app.copy(it.path) },
        { label: S.t('revealInFM'), run: () => app.revealInFM(it.path) },
      ], e.clientX, e.clientY);
    });
  }

  function renderDet(items: FileItem[]): void {
    const table = document.createElement('table');
    table.className = 'gg-files-table';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    const heads: [string, SortKey, number][] = [
      [S.t('filesColName'), 'name', 44],
      [S.t('filesColDate'), 'date', 24],
      [S.t('filesColType'), 'type', 20],
      [S.t('filesColSize'), 'size', 12],
    ];
    heads.forEach(([label, key, pct], i) => {
      const th = document.createElement('th');
      const style = S.files.cols ? `width:${S.files.cols[i]}px` : `width:${pct}%`;
      th.setAttribute('style', style);
      const span = el('span', undefined, label);
      if (sortKey === key) span.append(el('span', 'gg-files-sort-arr', sortAsc ? '▲' : '▼'));
      th.prepend(span);
      th.addEventListener('click', () => {
        if (sortKey === key) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        renderList();
      });
      // 列宽拖拽手柄（五审：每列可拖、松开记忆）
      const rs = el('span', 'gg-files-colrs');
      rs.dataset.i = String(i);
      rs.title = S.t('filesColResize');
      rs.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = th.offsetWidth;
        const mins = [110, 70, 60, 52];
        const move = (ev: MouseEvent) => {
          const w = Math.max(mins[i], startW + (ev.clientX - startX));
          th.style.width = w + 'px';
          if (S.files.cols) S.files.cols[i] = w;
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          if (!S.files.cols) S.files.cols = [...table.querySelectorAll('th')].map(t => t.offsetWidth);
          app.saveFilesLayout(S.files.paneW, S.files.cols);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      th.append(rs);
      trh.append(th);
    });
    thead.append(trh);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.className = 'gg-files-row' + (S.files.sel.includes(it.path) ? ' sel' : '');
      const tdN = document.createElement('td');
      const nm = el('span', 'gg-files-nm');
      nm.append(fileIconSvg(it.name, it.isDir), el('span', 'gg-files-nm-t', it.name));
      tdN.append(nm);
      const tdD = el('td', 'gg-files-dim', it.mtime ? formatDateTime(it.mtime) : '—');
      const tdT = el('td', 'gg-files-dim', it.isDir ? S.t('filesTypeFolder') : fileTypeInfo(it.name).type);
      const tdS = el('td', 'gg-files-dim gg-files-sz', it.isDir ? '—' : fmtSize(it.size ?? it.gitSize));
      tr.append(tdN, tdD, tdT, tdS);
      bindRow(tr, it);
      tbody.append(tr);
    }
    table.append(tbody);
    list.append(table);
    const n = items.length;
    list.append(el('div', 'gg-files-sum', S.files.sel.length
      ? `${n} ${S.t('filesItems')} · ${S.t('filesSelN', { n: String(S.files.sel.length) })}`
      : `${n} ${S.t('filesItems')}`));
  }

  function renderTile(items: FileItem[]): void {
    const grid = el('div', 'gg-files-grid');
    for (const it of items) {
      const card = el('div', 'gg-files-card' + (S.files.sel.includes(it.path) ? ' sel' : ''));
      const big = fileIconSvg(it.name, it.isDir, 30);
      big.classList.add('gg-files-card-ic');
      card.append(big, el('span', 'gg-files-card-nm', it.name));
      bindRow(card, it);
      grid.append(card);
    }
    list.append(grid);
    list.append(el('div', 'gg-files-sum', S.t('filesTileHint')));
  }

  // ---------- 地址栏编辑态 ----------
  function addrEdit(): void {
    addr.classList.add('edit');
    addrInput.style.display = 'block';
    addrInput.value = S.files.cwd;
    setTimeout(() => { addrInput.focus(); addrInput.select(); }, 0);
  }
  function addrCancel(): void {
    addr.classList.remove('edit', 'err');
    addrInput.style.display = 'none';
  }
  /** 地址栏错误反馈：红框 + toast（统一出口，避免分支各自实现漏提示） */
  function addrErr(msg: string): void {
    addr.classList.add('err');
    toast('warn', msg);
    setTimeout(() => addr.classList.remove('err'), 1500);
  }
  function addrGo(v: string): void {
    // Win11 式地址栏输入容错：去包裹引号（资源管理器「复制文件地址」带引号）、反斜杠统一为 /、
    // 绝对路径（盘符 / UNC / 根斜杠）换算为当前仓库相对路径后再走既有导航——
    // 白名单不含 ":"，绝对路径不换算会被宿主直接判 none（v0.14.4 前红框无果的根因）
    let s = v.trim().replace(/^"+|"+$/g, '').replace(/\\/g, '/');
    if (/^([a-z]:\/|\/)/i.test(s)) {
      const root = (S.repos.find(r => r.id === S.repoId) ?? S.repos[0])?.root ?? '';
      const nr = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const ns = s.replace(/\/+$/, '').toLowerCase();
      if (!nr) { addrErr(S.t('filesAddrOutside', { root: root || '?' })); return; }
      if (ns === nr) s = '';
      else if (ns.startsWith(nr + '/')) s = s.slice(nr.length + 1);
      else { addrErr(S.t('filesAddrOutside', { root })); return; }
    }
    const p = s.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!p || p === S.files.cwd) { app.filesNavigate(p); addrCancel(); return; }
    // 路径类型由宿主判定（files.ls 返回 kind）：目录→导航；文件→定位选中并打开
    void rpc('files.ls', { dir: p }).then((r: any) => {
      addrCancel();
      if (!r) return;
      if (r.kind === 'dir') {
        app.filesNavigate(p);
      } else if (r.kind === 'file') {
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        app.filesNavigate(dir);
        S.files.sel = [p];
        S.files.anchor = p;
        app.filesSelect(p, false);
        app.openFile(p);
      } else {
        addrErr(S.t('filesAddrNone', { p }));
      }
    }).catch(() => addrCancel());
  }

  // ---------- 面板宽度拖拽 + 记忆 ----------
  const splitter = el('div', 'gg-files-splitter');
  splitter.title = S.t('filesPaneResize');
  splitter.addEventListener('mousedown', e => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const w = Math.max(280, Math.min(640, ev.clientX));
      S.files.paneW = w;
      root.style.width = w + 'px';
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      app.saveFilesLayout(S.files.paneW, S.files.cols);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // 快捷键：F2 重命名 / Del 删除 / Ctrl+L 地址栏（仅文件视图激活时）
  document.addEventListener('keydown', e => {
    if (S.view !== 'files') return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'F2') { e.preventDefault(); if (S.files.sel.length === 1) app.folderRename(S.files.sel[0]); }
    else if (e.key === 'Delete') { e.preventDefault(); if (S.files.sel.length) app.folderDelete([...S.files.sel]); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); addrEdit(); }
  });

  function reset(): void {
    S.files.cwd = '';
    S.files.items = [];
    S.files.sel = [];
    S.files.filter = '';
    fltInput.value = '';
    update();
  }

  return { el: root, splitter, update, reset };
}
