/** 内联 unified diff 渲染（设计方案 7.2）。紧凑模式只显示增删行，无差异段落折叠为 ⋯。
 *  v0.7.2：行数超阈值时分块挂载（首块 500 行 + “展开剩余”），避免一次挂载数千节点。 */
import type { DiffPayload, DiffLine } from '../../common/models';
import { S } from '../state';
import { el, clearChildren } from '../util';

/** 单次挂载的最大行数（超出部分由按钮按块展开） */
const CHUNK = 500;

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

  // 先按行规格构建全部节点（不挂载），再分块挂载。
  // 行统一挂在 .gg-diff-inner 内层（inline-block + min-width:100%）：
  // 内层宽 = max(可视宽, 最长行)，行背景得以铺满整个横向滚动区，而非仅可视宽
  const inner = el('div', 'gg-diff-inner');
  const rows: HTMLElement[] = [];
  for (const hunk of payload.diff.hunks) {
    rows.push(el('div', 'gg-dl hunk', hunk.header));

    if (!compact) {
      for (const line of hunk.lines) rows.push(lineRow(line));
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
        rows.push(gapRow(line));
      }
      gapPending = false;
      rows.push(lineRow(line));
      shown++;
    }
  }

  let shownCount = 0;
  const moreBtn = rows.length > CHUNK ? el('button', 'gg-btn small gg-diff-more') : undefined;
  const appendChunk = (): void => {
    const next = Math.min(rows.length, shownCount + CHUNK);
    const frag = document.createDocumentFragment();
    for (; shownCount < next; shownCount++) frag.appendChild(rows[shownCount]);
    inner.insertBefore(frag, null);
    if (moreBtn) {
      if (shownCount >= rows.length) moreBtn.remove();
      else moreBtn.textContent = S.t('showMoreLines', { n: rows.length - shownCount });
    }
  };
  if (moreBtn) {
    moreBtn.addEventListener('click', appendChunk);
    moreBtn.textContent = S.t('showMoreLines', { n: rows.length - Math.min(CHUNK, rows.length) });
  }
  container.appendChild(inner);
  if (moreBtn) container.appendChild(moreBtn);
  appendChunk();
}

function lineRow(line: DiffLine): HTMLElement {
  const row = el('div', `gg-dl ${line.kind}`);
  // 行号双列包一层 sticky：横向滚动长行时行号固定在左缘（背景不透明，遮挡滚过的文字）
  const nos = el('span', 'gg-lnos');
  const oldNo = el('span', 'gg-ln', line.oldNo !== undefined ? String(line.oldNo) : '');
  const newNo = el('span', 'gg-ln', line.newNo !== undefined ? String(line.newNo) : '');
  nos.append(oldNo, newNo);
  const marker = el('span', 'gg-mark', line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ');
  const text = el('span', 'gg-text');
  text.textContent = line.text || ' ';
  row.append(nos, marker, text);
  return row;
}

function gapRow(next: DiffLine): HTMLElement {
  const oldNo = next.oldNo !== undefined ? String(next.oldNo) : '';
  const newNo = next.newNo !== undefined ? String(next.newNo) : '';
  const label = oldNo && newNo ? `${oldNo} → ${newNo}` : (oldNo || newNo);
  return el('div', 'gg-dl gap', `⋯ ${label} ⋯`);
}
