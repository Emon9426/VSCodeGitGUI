/**
 * 详情面板（设计方案 4.5）：概要 + 变更文件 + 内联 diff。
 * 双击文件打开 VS Code 内置差异编辑器；右键文件提供打开/定位/复制。
 */
import type { FileChange } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren, formatTime } from '../util';
import { renderDiff } from '../diff/render';
import { showContextMenu } from './overlays';

export interface DetailPanel {
  el: HTMLElement;
  update(): void;
  configChanged(): void;
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
  const filesHead = el('div', 'gg-files-head');
  const filesList = el('div', 'gg-files');
  left.append(summary, msgBlock, filesHead, filesList);
  const diffHead = el('div', 'gg-diff-head');
  const diffPath = el('span', 'gg-diff-path');
  const diffOpenBtn = el('button', 'gg-btn small');
  const diffBox = el('div', 'gg-diff-box');
  right.append(diffHead, diffBox);
  diffHead.append(diffPath, diffOpenBtn);
  body.append(left, right);
  root.append(handle, head, body);

  let collapsed = false;
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    root.classList.toggle('collapsed', collapsed);
  });

  handle.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = parseInt(getComputedStyle(root).getPropertyValue('--gg-detail-h'), 10) || 220;
    const maxH = window.innerHeight - 220;
    const move = (ev: PointerEvent) => {
      const h = Math.max(120, Math.min(maxH, startH - (ev.clientY - startY)));
      root.style.setProperty('--gg-detail-h', `${h}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
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

    // 文件列表
    const totalAdd = d.files.reduce((s, f) => s + (f.additions ?? 0), 0);
    const totalDel = d.files.reduce((s, f) => s + (f.deletions ?? 0), 0);
    filesHead.textContent = `${S.t('changedFiles')} · ${d.files.length} · +${totalAdd} −${totalDel}`;
    clearChildren(filesList);
    for (const f of d.files) filesList.appendChild(fileRow(app, f));
    if (!S.selectedFile && d.files.length) {
      S.selectedFile = d.files[0].path;
      app.requestDiff(d.sha, d.files[0].path);
    }

    // diff
    diffOpenBtn.textContent = S.t('openInDiffEditor');
    diffPath.textContent = S.selectedFile ?? '';
    renderDiff(diffBox, S.selectedFile ? S.diff : undefined, S.selectedFile, () => {
      if (S.detail && S.selectedFile) app.openDiffEditor(S.detail.sha, S.selectedFile);
    });
    updateFileSelection();
  }

  function updateFileSelection(): void {
    for (const rowEl of filesList.children) {
      (rowEl as HTMLElement).classList.toggle('selected', (rowEl as any)._path === S.selectedFile);
    }
  }

  function fileRow(app2: App, f: FileChange): HTMLElement {
    const row = el('div', 'gg-file');
    (row as any)._path = f.path;
    row.appendChild(el('span', `gg-st ${f.status}`, STATUS_LABEL[f.status] ?? f.status));
    const num = el('span', 'gg-num');
    if (f.additions !== undefined) {
      num.appendChild(el('b', 'a', `+${f.additions}`));
      num.appendChild(document.createTextNode(' '));
      num.appendChild(el('b', 'd', `−${f.deletions ?? 0}`));
    }
    row.appendChild(num);
    const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const pathEl = el('span', 'gg-file-path', label);
    row.appendChild(pathEl);
    row.addEventListener('click', () => {
      S.selectedFile = f.path;
      if (S.detail) app.requestDiff(S.detail.sha, f.path);
      updateFileSelection();
      diffPath.textContent = f.path;
      renderDiff(diffBox, S.diff, S.selectedFile, () => {
        if (S.detail) app.openDiffEditor(S.detail.sha, f.path);
      });
    });
    row.addEventListener('dblclick', () => {
      if (S.detail) app.openDiffEditor(S.detail.sha, f.path);
    });
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      const sha = S.detail?.sha;
      showContextMenu([
        { label: S.t('openInDiffEditor'), run: () => sha && app.openDiffEditor(sha, f.path) },
        { sep: true },
        { label: S.t('openFile'), run: () => app.openFile(f.path) },
        { label: S.t('openAtRevision'), run: () => sha && app.openFileAt(sha, f.path) },
        { label: S.t('revealInFM'), run: () => app.revealInFM(f.path) },
        { sep: true },
        { label: S.t('copyPath'), run: () => app.copy(f.path) },
      ], e.clientX, e.clientY);
    });
    return row;
  }

  return {
    el: root,
    update,
    configChanged: update,
  };
}
