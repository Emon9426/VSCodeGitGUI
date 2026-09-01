/**
 * 背景色卡片节点（v0.15.0）：Confluence 式预制容器（信息/成功/警告/危险/笔记），
 * content 为任意块（block+）。vanilla NodeView：图标（点击切类型）+ 标题栏（可编辑）+ 内容容器。
 * v0.18 反馈 #8：标题始终可编辑（contentEditable，空时显示占位符，加粗显示）。
 * v0.18 反馈 #9：光标位于卡片内时显示整块删除按钮（.cur）。
 */
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import type { CalloutKind } from '../../../common/notesProtocol';
import { el } from '../../util';
import { mkNodeDelBtn } from './blockdel';

export const CALLOUT_KINDS: { kind: CalloutKind; icon: string }[] = [
  { kind: 'info', icon: 'ℹ️' },
  { kind: 'ok', icon: '✅' },
  { kind: 'warn', icon: '⚠️' },
  { kind: 'danger', icon: '⛔' },
  { kind: 'note', icon: '📝' },
];

export interface CalloutMenuHost {
  showKindMenu(x: number, y: number, current: CalloutKind, onPick: (k: CalloutKind) => void): void;
}

export interface CalloutCommands {
  /** 当前选区（或插入新）卡片设置类型与可选标题 */
  setCallout(kind: CalloutKind, title?: string): void;
}

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    callout: {
      /** 光标处插入背景卡片（或把选中块转为卡片） */
      insertCallout(kind: CalloutKind, title?: string): ReturnType;
      /** 设置选区内卡片类型 */
      setCalloutKind(kind: CalloutKind): ReturnType;
    };
  }
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return { menuHost: undefined as CalloutMenuHost | undefined };
  },

  addAttributes() {
    return {
      kind: { default: 'info' as CalloutKind },
      title: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ node }) {
    const kind = String(node.attrs.kind ?? 'info');
    return ['div', mergeAttributes({ 'data-callout': kind, 'data-title': String(node.attrs.title ?? ''), class: `gg-callout co-${kind}` }), 0];
  },

  addCommands() {
    return {
      insertCallout: (kind: CalloutKind, title = '') => ({ chain }) =>
        chain().insertContent({
          type: 'callout',
          attrs: { kind, title },
          content: [{ type: 'paragraph' }],
        }).run(),
      setCalloutKind: (kind: CalloutKind) => ({ state, dispatch }) => {
        const { from, to } = state.selection;
        let touched = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (node.type.name === 'callout') {
            if (dispatch) dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, kind }));
            touched = true;
            return false;
          }
          return true;
        });
        return touched;
      },
    };
  },

  addNodeView() {
    const opts = this.options as { menuHost?: CalloutMenuHost };
    return ({ node, editor, getPos }: { node: any; editor: Editor; getPos: () => number | undefined }) => {
      const wrap = el('div', 'gg-callout');
      const head = el('div', 'gg-callout-head');
      const icon = el('span', 'gg-callout-icon');
      icon.title = '切换类型';
      // v0.18 反馈 #8：标题可直接输入（空时 CSS 占位符提示，加粗），不再隐藏
      const title = el('div', 'gg-callout-title');
      title.contentEditable = 'true';
      title.dataset.ph = ((window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k))('notesCalloutTitlePh');
      const content = el('div', 'gg-callout-body');
      const t = (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k);
      head.append(icon, title);
      wrap.append(head, content);
      // v0.18 反馈 #9：整块删除按钮（光标位于卡片内时显示）
      const delBtn = mkNodeDelBtn(editor, getPos, t('notesDeleteBlock'));
      wrap.append(delBtn);

      // 只切换 co-* 类，不整体重写 className（避免抹掉运行态类）
      const applyKind = (k: string, ttl: string): void => {
        for (const x of CALLOUT_KINDS) wrap.classList.remove(`co-${x.kind}`);
        wrap.classList.add(`co-${k}`);
        icon.textContent = CALLOUT_KINDS.find(x => x.kind === k)?.icon ?? 'ℹ️';
        if (document.activeElement !== title) title.textContent = ttl;
      };
      applyKind(String(node.attrs.kind ?? 'info'), String(node.attrs.title ?? ''));

      const setAttrs = (patch: { kind?: string; title?: string }): void => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur) return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...patch }));
      };

      icon.addEventListener('click', e => {
        e.stopPropagation();
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur) return;
        const r = icon.getBoundingClientRect();
        opts.menuHost?.showKindMenu(r.left, r.bottom, cur.attrs.kind, k => setAttrs({ kind: k }));
      });
      // 标题编辑：input 回写属性；Enter 落到正文；按键不进 ProseMirror
      title.addEventListener('input', () => setAttrs({ title: title.textContent ?? '' }));
      title.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = content.querySelector<HTMLElement>('.ProseMirror');
          (first ?? content).focus();
        }
      });
      title.addEventListener('mousedown', e => e.stopPropagation());

      // 光标进出卡片 → 删除按钮显隐（挂在按钮自身：NodeView 根元素 class 会被整体重写）
      const syncSel = (): void => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        const inside = !!cur && editor.state.selection.from >= pos && editor.state.selection.to <= pos + cur.nodeSize;
        delBtn.classList.toggle('show', inside);
      };
      editor.on('transaction', syncSel);
      editor.on('selectionUpdate', syncSel);
      syncSel();

      return {
        dom: wrap,
        contentDOM: content,
        update(newNode: any) {
          if (newNode.type.name !== 'callout') return false;
          applyKind(String(newNode.attrs.kind ?? 'info'), String(newNode.attrs.title ?? ''));
          return true;
        },
        ignoreMutation(m: any) {
          // 标题栏由 NodeView 自管（contenteditable 的独立子树），交给 input 事件回写
          return m.target === title || title.contains(m.target);
        },
        destroy() {
          editor.off('transaction', syncSel);
          editor.off('selectionUpdate', syncSel);
        },
      };
    };
  },
});
