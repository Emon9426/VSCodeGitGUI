/**
 * 详情面板（设计方案 4.5）：概要 + 变更文件 + 内联 diff。
 * 双击文件打开 VS Code 内置差异编辑器；右键文件提供打开/定位/复制。
 * 文件列表支持 Ctrl/Shift 多选，一次在 VS Code 中打开多个文件（v0.11）；
 * 面板高度以百分比（vh）记忆——不同尺寸屏幕按相对高度恢复（v0.11）。
 */
import type { FileChange } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren, formatTime } from '../util';
import { rpc } from '../rpc';
import { renderDiff } from '../diff/render';
import { setIcon } from '../icons';
import { showContextMenu, type MenuItem } from './overlays';

export interface DetailPanel {
  el: HTMLElement;
  update(): void;
  configChanged(): void;
  /** 应用持久化的高度百分比（ready 事件到达后调用；vh 单位随窗口尺寸等比缩放） */
  applyHeightPct(): void;
}

const STATUS_LABEL: Record<string, string> = { A: 'A', M: 'M', D: 'D', R: 'R', C: 'C', T: 'T' };

export function createDetailPanel(app: App): DetailPanel {
  const root = el('div', 'gg-detail');
  root.style.setProperty('--gg-detail-h', '220px');
  const handle = el('div', 'gg-detail-handle');
  const head = el('div', 'gg-detail-head');
  const headSha = el('span', 'gg-detail-sha');
  const collapseBtn = el('button', 'gg-icon-btn', '⌃');
  collapseBtn.title = '⌃';
  head.append(headSha, collapseBtn);
  const body = el('div', 'gg-detail-body');
  const left = el('div', 'gg-detail-left');
  const right = el('div', 'gg-detail-right');
  const summary = el('div', 'gg-summary');
  const msgBlock = el('div', 'gg-message');
  // 类名前缀 gg-dfiles：避免与文件页（filesView）的 gg-files* 同名导致 CSS 互相污染（v0.14.3 穿模根因）
  const filesHead = el('div', 'gg-dfiles-head');
  const filesHeadText = el('span', 'gg-dfiles-head-t');
  const filesOpenBtn = el('button', 'gg-icon-btn');   // 打开选中文件（多选）
  setIcon(filesOpenBtn, 'goToFile');
  filesHead.append(filesHeadText, filesOpenBtn);
  const filesList = el('div', 'gg-dfiles');
  left.append(summary, msgBlock, filesHead, filesList);
  const diffHead = el('div', 'gg-diff-head');
  const diffPath = el('span', 'gg-diff-path');
  const diffRevealBtn = el('button', 'gg-btn small', '📂');
  const diffVscodeBtn = el('button', 'gg-icon-btn');   // 在 VS Code 中打开工作区文件
  setIcon(diffVscodeBtn, 'goToFile');
  const diffModeBtn = el('button', 'gg-btn small');
  const diffOpenBtn = el('button', 'gg-btn small');
  const diffBox = el('div', 'gg-diff-box');
  right.append(diffHead, diffBox);
  diffHead.append(diffPath, diffRevealBtn, diffVscodeBtn, diffModeBtn, diffOpenBtn);
  body.append(left, right);
  root.append(handle, head, body);

  /** 紧凑差异（默认）：只显示增删行，无差异段落折叠为 ⋯ */
  let compactDiff = true;

  /** 文件多选集合（Ctrl 累积 / Shift 范围）；S.selectedFile 始终是 diff 显示锚点 */
  const selectedFiles = new Set<string>();
  let multiSelSha = '';   // 多选所属提交：换提交即复位为单选

  function selectedPaths(): string[] {
    if (selectedFiles.size) return [...selectedFiles];
    return S.selectedFile ? [S.selectedFile] : [];
  }

  filesOpenBtn.addEventListener('click', () => {
    const paths = selectedPaths();
    if (paths.length) app.openFiles(paths);
  });

  diffRevealBtn.addEventListener('click', () => {
    if (S.selectedFile) app.revealInFM(S.selectedFile);
  });

  diffVscodeBtn.addEventListener('click', () => {
    if (S.selectedFile) app.openFile(S.selectedFile);   // 工作区不存在（历史版本已删）时宿主 toast 提示
  });

  function renderDiffNow(): void {
    diffRevealBtn.title = S.t('revealInFM');
    diffVscodeBtn.title = S.t('openFile');
    diffModeBtn.textContent = compactDiff ? S.t('diffContext') : S.t('diffCompact');
    diffModeBtn.title = S.t('diffModeTitle');
    diffOpenBtn.textContent = S.t('openInDiffEditor');
    renderDiff(diffBox, S.selectedFile ? S.diff : undefined, S.selectedFile, compactDiff, () => {
      if (S.detail && S.selectedFile) app.openDiffEditor(S.detail.sha, S.selectedFile);
    });
  }

  diffModeBtn.addEventListener('click', () => {
    compactDiff = !compactDiff;
    renderDiffNow();
  });

  let collapsed = false;
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
  });

  /** 应用持久化的高度百分比（vh 单位随窗口尺寸等比缩放） */
  function applyHeightPct(): void {
    const pct = S.detailPct;
    if (typeof pct === 'number' && pct >= 5 && pct <= 95) {
      root.style.setProperty('--gg-detail-h', `${pct}vh`);
    }
  }

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startY = e.clientY;
    // 变量可能是 px（拖拽中）或 vh（恢复/上次拖完）——统一换算成像素
    const rawH = getComputedStyle(root).getPropertyValue('--gg-detail-h').trim();
    const startH = rawH.endsWith('vh')
      ? (parseFloat(rawH) / 100) * window.innerHeight
      : parseInt(rawH, 10) || 220;
    const maxH = window.innerHeight - 220;
    let lastH = startH;
    const move = (ev: PointerEvent) => {
      const h = Math.max(120, Math.min(maxH, startH - (ev.clientY - startY)));
      lastH = h;
      root.style.setProperty('--gg-detail-h', `${h}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // 以百分比记忆并立即换算回 vh：之后窗口/不同尺寸屏幕均按相对高度呈现
      const pct = Math.max(8, Math.min(85, Math.round((lastH / window.innerHeight) * 1000) / 10));
      S.detailPct = pct;
      root.style.setProperty('--gg-detail-h', `${pct}vh`);
      void rpc('ui:saveDetailPct', { pct }).catch(() => undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  diffOpenBtn.addEventListener('click', () => {
    if (S.detail && S.selectedFile) app.openDiffEditor(S.detail.sha, S.selectedFile);
  });

  function update(): void {
    root.classList.toggle('hidden', !S.detail && !S.detailLoading);
    root.classList.toggle('stale', !!S.detailLoading);
    const d = S.detail;
    if (!d) return;
    root.classList.toggle('right', S.config.detailPanelPosition === 'right');
    headSha.textContent = d.shortSha;
    collapseBtn.textContent = collapsed ? '⌄' : '⌃';

    // 概要
    clearChildren(summary);
    const ft = (iso: string) => formatTime(iso, S.config.dateFormat === 'iso' ? 'iso' : 'datetime', S.t);
    const row = (label: string, value: string, copyBtn?: boolean) => {
      const r = el('div', 'gg-sum-row');
      r.appendChild(el('span', 'gg-sum-label', label));
      const v = el('span', 'gg-sum-value', value);
      r.appendChild(v);
      if (copyBtn) {
        const b = el('button', 'gg-mini-btn', S.t('copy'));
        b.addEventListener('click', () => app.copy(value));
        r.appendChild(b);
      }
      summary.appendChild(r);
    };
    row('SHA', d.sha, true);
    row(S.t('author'), `${d.author.name} <${d.author.email}>`);
    row(S.t('authorDate'), ft(d.author.date));
    row(S.t('committer'), `${d.committer.name} <${d.committer.email}>`);
    row(S.t('commitDate'), ft(d.committer.date));

    // 完整提交注释
    msgBlock.textContent = d.subject + (d.body ? `\n${d.body}` : '');
    if (d.parents.length > 1) {
      const note = el('div', 'gg-merge-note', S.t('mergeDiffNote'));
      msgBlock.appendChild(note);
    }

    // 文件列表：按目录分组——组头显示目录路径一次（根目录组显示仓库绝对路径），
    // 组内行只显示文件名；状态/数字列固定占位，二进制文件（无 ± 数字）文件名也对齐
    const totalAdd = d.files.reduce((s, f) => s + (f.additions ?? 0), 0);
    const totalDel = d.files.reduce((s, f) => s + (f.deletions ?? 0), 0);
    if (d.sha !== multiSelSha) {
      multiSelSha = d.sha;
      selectedFiles.clear();
    }
    filesHeadText.textContent = `${S.t('changedFiles')} · ${d.files.length} · +${totalAdd} −${totalDel}`;
    filesOpenBtn.title = S.t('openSelectedFiles', { n: String(Math.max(1, selectedPaths().length)) });
    clearChildren(filesList);
    const groups = new Map<string, FileChange[]>();
    for (const f of d.files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/') + 1) : '';
      const list = groups.get(dir);
      if (list) list.push(f); else groups.set(dir, [f]);
    }
    // 根目录组('')置顶，其余按路径字母序
    const dirs = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    const repoRoot = S.repos.find(r => r.id === S.repoId)?.root;
    for (const dir of dirs) {
      const headText = dir === '' ? (repoRoot ?? '/') : dir;
      const groupHead = el('div', 'gg-file-group', headText);
      groupHead.title = headText;
      filesList.appendChild(groupHead);
      for (const f of groups.get(dir)!) filesList.appendChild(fileRow(app, f));
    }
    if (!S.selectedFile && d.files.length) {
      S.selectedFile = d.files[0].path;
      app.requestDiff(d.sha, d.files[0].path);
    }

    // diff
    diffPath.textContent = S.selectedFile ?? '';
    renderDiffNow();
    updateFileSelection();
  }

  function updateFileSelection(): void {
    for (const rowEl of filesList.children) {
      const p = (rowEl as any)._path as string | undefined;
      (rowEl as HTMLElement).classList.toggle('selected', !!p && (p === S.selectedFile || selectedFiles.has(p)));
    }
  }

  function fileRow(app2: App, f: FileChange): HTMLElement {
    const row = el('div', 'gg-file');
    (row as any)._path = f.path;
    row.appendChild(el('span', `gg-st ${f.status}`, STATUS_LABEL[f.status] ?? f.status));
    const num = el('span', 'gg-num');
    if (f.additions !== undefined) {
      num.appendChild(el('b', 'a', `+${f.additions}`));
      num.appendChild(el('b', 'd', `−${f.deletions ?? 0}`));
    } else {
      // 二进制文件：空数字占位（b 有 min-width），文件名与相邻行对齐
      num.appendChild(el('b'));
      num.appendChild(el('b'));
    }
    row.appendChild(num);
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    const label = f.oldPath ? `${base(f.oldPath)} → ${base(f.path)}` : base(f.path);
    const pathEl = el('span', 'gg-file-path', label);
    pathEl.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    row.appendChild(pathEl);
    row.addEventListener('click', e => {
      // 多选：Ctrl/⌘ 累积、Shift 范围（自上一个锚点起）；单击恢复单选
      const files = S.detail?.files ?? [];
      if (e.shiftKey) {
        const from = files.findIndex(fc => fc.path === S.selectedFile);
        const to = files.findIndex(fc => fc.path === f.path);
        selectedFiles.clear();
        if (from >= 0 && to >= 0) {
          const [a, b] = from <= to ? [from, to] : [to, from];
          for (let i = a; i <= b; i++) selectedFiles.add(files[i].path);
        } else {
          selectedFiles.add(f.path);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (!selectedFiles.size && S.selectedFile) selectedFiles.add(S.selectedFile);
        if (selectedFiles.has(f.path)) selectedFiles.delete(f.path);
        else selectedFiles.add(f.path);
      } else {
        selectedFiles.clear();
        selectedFiles.add(f.path);
      }
      S.selectedFile = f.path;
      if (S.detail) app.requestDiff(S.detail.sha, f.path);
      updateFileSelection();
      diffPath.textContent = f.path;
      renderDiffNow();
      filesOpenBtn.title = S.t('openSelectedFiles', { n: String(Math.max(1, selectedPaths().length)) });
    });
    row.addEventListener('dblclick', () => {
      if (S.detail) app.openDiffEditor(S.detail.sha, f.path);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const sha = S.detail?.sha;
      // 右键行在多选集合内时，首项提供批量打开；其余项仍作用于被右键的这行
      const items: MenuItem[] = [];
      if (selectedFiles.size > 1 && selectedFiles.has(f.path)) {
        items.push({ label: S.t('openSelectedFiles', { n: selectedFiles.size }), run: () => app.openFiles([...selectedFiles]) });
        items.push({ sep: true });
      }
      items.push(
        { label: S.t('openInDiffEditor'), run: () => sha && app.openDiffEditor(sha, f.path) },
        { sep: true },
        { label: S.t('openFile'), run: () => app.openFile(f.path) },
        { label: S.t('openAtRevision'), run: () => sha && app.openFileAt(sha, f.path) },
        { label: S.t('revealInFM'), run: () => app.revealInFM(f.path) },
        { sep: true },
        { label: S.t('copyPath'), run: () => app.copy(f.path) },
      );
      showContextMenu(items, e.clientX, e.clientY);
    });
    return row;
  }

  return {
    el: root,
    update,
    configChanged: update,
    applyHeightPct,
  };
}
