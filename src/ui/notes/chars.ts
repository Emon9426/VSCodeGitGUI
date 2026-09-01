/**
 * 显示所有字符（v0.16，Notepad++ 式）：空格显 ·、制表显 →、段尾显 ¶、硬换行显 ↵。
 * 以 ProseMirror decorations 实现（widget 叠加，不改动文档）；开关状态由 main 持有，
 * 切换时通过 setMeta 强制重算。
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

export const showCharsKey = new PluginKey<boolean>('gitboardShowChars');

export function setShowChars(view: EditorView, on: boolean): void {
  view.dispatch(view.state.tr.setMeta(showCharsKey, on));
}

export const ShowChars = Extension.create({
  name: 'showChars',

  addProseMirrorPlugins() {
    return [
      new Plugin<boolean>({
        key: showCharsKey,
        state: {
          init: () => false,
          apply: (tr: Transaction, prev: boolean): boolean => {
            const meta = tr.getMeta(showCharsKey);
            return typeof meta === 'boolean' ? meta : prev;
          },
        },
        props: {
          decorations(state: EditorState): DecorationSet | undefined {
            if (!showCharsKey.getState(state)) return DecorationSet.empty;
            const widgets: Decoration[] = [];
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'text') {
                const text = node.text ?? '';
                for (let i = 0; i < text.length; i++) {
                  const ch = text[i];
                  if (ch === ' ' || ch === '\u00A0') {
                    widgets.push(Decoration.inline(pos + i, pos + i + 1, { class: 'gg-ws gg-ws-space' }));
                  } else if (ch === '\t') {
                    widgets.push(Decoration.inline(pos + i, pos + i + 1, { class: 'gg-ws gg-ws-tab' }));
                  }
                }
              } else if (node.type.name === 'hardBreak') {
                widgets.push(Decoration.widget(pos + 1, () => {
                  const s = document.createElement('span');
                  s.className = 'gg-ws-mark';
                  s.textContent = '↵';
                  return s;
                }));
              } else if (node.isTextblock && node.type.name !== 'codeBlock') {
                // v0.16.1（Notepad++ 语义）：每个文本块行尾都显示 ¶（含非空段；代码块跳过防高亮 DOM 干扰）
                widgets.push(Decoration.widget(pos + node.nodeSize - 1, () => {
                  const s = document.createElement('span');
                  s.className = 'gg-ws-mark gg-ws-eol';
                  s.textContent = '¶';
                  return s;
                }));
              }
              return true;
            });
            return DecorationSet.create(state.doc, widgets);
          },
        },
      }),
    ];
  },
});
