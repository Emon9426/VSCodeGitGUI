/**
 * v0.18 反馈 #9：非正文元素（图片/信息块/代码块/画板/分隔线）选中态删除按钮。
 * mkNodeDelBtn 供各 NodeView 挂载（.gb-nodedel，绝对定位在节点右上角）；
 * 显隐由宿主类控制：.sel（NodeSelection）/ .cur（光标位于容器内），见 notes.css。
 * GbHorizontalRule 给分隔线补 NodeView（原本无 DOM 包裹，无法承载按钮）。
 */
import { Editor } from '@tiptap/core';
import HorizontalRule from '@tiptap/extension-horizontal-rule';

const DEL_SVG = '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.8h3V4M4 4l.7 9.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.6 7v4.5M9.4 7v4.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

/** 删除整个节点（doc 仅剩该节点时清空为空文档，保证 schema 合法） */
export function deleteNodeAt(editor: Editor, getPos: () => number | undefined): void {
  const pos = getPos();
  if (typeof pos !== 'number') return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  if (editor.state.doc.childCount <= 1) {
    editor.chain().focus().clearContent().run();
    return;
  }
  editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
}

export function mkNodeDelBtn(editor: Editor, getPos: () => number | undefined, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'gb-nodedel';
  b.innerHTML = DEL_SVG;
  b.title = title;
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
  b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); deleteNodeAt(editor, getPos); });
  return b;
}

/** 分隔线：NodeView 包裹一层 .gb-hr，NodeSelection 时显示删除按钮 */
export const GbHorizontalRule = HorizontalRule.extend({
  addNodeView() {
    return ({ editor, getPos }) => {
      const wrap = document.createElement('div');
      wrap.className = 'gb-hr';
      const hr = document.createElement('hr');
      const t = (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k);
      wrap.append(hr, mkNodeDelBtn(editor, getPos as () => number | undefined, t('notesDeleteBlock')));
      return {
        dom: wrap,
        selectNode() { wrap.classList.add('sel'); },
        deselectNode() { wrap.classList.remove('sel'); },
      };
    };
  },
});
