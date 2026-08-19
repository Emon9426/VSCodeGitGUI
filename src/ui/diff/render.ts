/** 内联 unified diff 渲染（设计方案 7.2）。紧凑模式只显示增删行，无差异段落折叠为 ⋯。 */
import type { DiffPayload, DiffLine } from '../../common/models';
import { S } from '../state';
import { el, clearChildren } from '../util';

export function renderDiff(
  container: HTMLElement,
  payload: DiffPayload | undefined,
  path: string | undefined,
  compact: boolean,
  onOpenBuiltin: () => void,
): void {
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

    if (!compact) {
      for (const line of hunk.lines) frag.appendChild(lineRow(line));
      continue;
    }
    // 紧凑模式：跳过上下文行，在断层处插入 ⋯ 行（标注下一处差异的行号）
    let gapPending = false;
    let shown = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'ctx') {
        gapPending = true;
        continue;
      }
      if (gapPending && shown > 0) {
        frag.appendChild(gapRow(line));
      }
      gapPending = false;
      frag.appendChild(lineRow(line));
      shown++;
    }
  }
  container.appendChild(frag);
}

function lineRow(line: DiffLine): HTMLElement {
  const row = el('div', `gg-dl ${line.kind}`);
  const oldNo = el('span', 'gg-ln', line.oldNo !== undefined ? String(line.oldNo) : '');
  const newNo = el('span', 'gg-ln', line.newNo !== undefined ? String(line.newNo) : '');
  const marker = el('span', 'gg-mark', line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ');
  const text = el('span', 'gg-text');
  text.textContent = line.text || ' ';
  row.append(oldNo, newNo, marker, text);
  return row;
}

function gapRow(next: DiffLine): HTMLElement {
  const oldNo = next.oldNo !== undefined ? String(next.oldNo) : '';
  const newNo = next.newNo !== undefined ? String(next.newNo) : '';
  const label = oldNo && newNo ? `${oldNo} → ${newNo}` : (oldNo || newNo);
  return el('div', 'gg-dl gap', `⋯ ${label} ⋯`);
}
