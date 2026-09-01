/**
 * 大纲视图（v0.15.0 右栏）：H1–H4 树、点击滚动定位、光标所在章节高亮。
 * 数据由 main 在 editor onUpdate/onSelectionUpdate 时推送（extractOutline / currentHeadingPos）。
 */
import type { OutlineItem } from './editor/setup';
import { el, clearChildren } from '../util';

export interface NotesOutline {
  el: HTMLElement;
  setItems(items: OutlineItem[]): void;
  setActive(pos: number | undefined): void;
}

export function createOutline(t: (k: string) => string, onJump: (pos: number) => void): NotesOutline {
  const root = el('div', 'n-outline');
  root.appendChild(el('div', 'n-ol-head', t('notesOutline')));
  const tree = el('div', 'n-ol-tree');
  root.appendChild(tree);

  let items: OutlineItem[] = [];
  let activePos: number | undefined;

  function render(): void {
    clearChildren(tree);
    if (!items.length) {
      tree.appendChild(el('div', 'n-ol-empty', '—'));
      return;
    }
    for (const it of items) {
      const b = el('button', `n-ol-item lv-${Math.min(4, it.level)}${it.pos === activePos ? ' on' : ''}`) as HTMLButtonElement;
      b.textContent = it.text || '(空标题)';
      b.title = it.text;
      b.addEventListener('click', () => onJump(it.pos));
      tree.appendChild(b);
    }
  }

  render();
  return {
    el: root,
    setItems(next: OutlineItem[]) { items = next; render(); },
    setActive(pos: number | undefined) { activePos = pos; render(); },
  };
}
