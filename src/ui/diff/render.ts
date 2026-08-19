/** 内联 unified diff 渲染（设计方案 7.2）。 */
import type { DiffPayload } from '../../common/models';
import { S } from '../state';
import { el, clearChildren } from '../util';

export function renderDiff(container: HTMLElement, payload: DiffPayload | undefined, path: string | undefined, onOpenBuiltin: () => void): void {
  clearChildren(container);
  if (!payload || !path) return;

  if (payload.kind === 'binary') {
    container.appendChild(el('div', 'gg-diff-note', S.t('binaryFile')));
    return;
  }
  if (payload.kind === 'tooLarge') {
    container.appendChild(el('div', 'gg-diff-note', S.t('tooLargeDiff')));
    const btn = el('button', 'gg-btn small', S.t('openInDiffEditor'));
    btn.addEventListener('click', onOpenBuiltin);
    container.appendChild(btn);
    return;
  }
  if (payload.kind === 'empty') {
    container.appendChild(el('div', 'gg-diff-note', '—'));
    return;
  }

  const frag = document.createDocumentFragment();
  for (const hunk of payload.diff.hunks) {
    frag.appendChild(el('div', 'gg-dl hunk', hunk.header));
    for (const line of hunk.lines) {
      const row = el('div', `gg-dl ${line.kind}`);
      const oldNo = el('span', 'gg-ln', line.oldNo !== undefined ? String(line.oldNo) : '');
      const newNo = el('span', 'gg-ln', line.newNo !== undefined ? String(line.newNo) : '');
      const marker = el('span', 'gg-mark', line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ');
      const text = el('span', 'gg-text');
      text.textContent = line.text || ' ';
      row.append(oldNo, newNo, marker, text);
      frag.appendChild(row);
    }
  }
  container.appendChild(frag);
}
