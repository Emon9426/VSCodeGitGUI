/**
 * TipTap 装配（v0.16）：lowlight 代码高亮（可选语言）、Ctrl+M 行内代码、
 * 卡片/引用块 Enter·↓ 逃逸（末尾空段时移出容器）、字号字体、大纲提取。
 */
import { Editor, Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import FontFamily from '@tiptap/extension-font-family';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { TextSelection } from '@tiptap/pm/state';
import { Callout, type CalloutMenuHost } from './callout';
import { Sketch } from './sketch';
import { GbImage, ImageInput } from './image';
import { GbCodeBlock, lowlight } from './codeview';
import { GbHorizontalRule } from './blockdel';
import { ShowChars } from '../chars';

export const FONT_SIZES = [12, 13, 14, 16, 18, 20, 24, 28, 32];

/** 行内代码快捷键 Ctrl+M（v0.16 反馈 #6；toggleCode 由 StarterKit 的 Code mark 提供） */
const CodeHotkey = Extension.create({
  name: 'codeHotkey',
  addKeyboardShortcuts() {
    return {
      'Mod-m': () => this.editor.commands.toggleCode(),
    };
  },
});

/** Tab 插入制表符（v0.16.1 反馈 #3：正文可打 Tab；pre-wrap 下真实渲染，显示字符模式可见 →） */
const TabInput = Extension.create({
  name: 'tabInput',
  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.insertContent('\t'),
    };
  },
});

/**
 * 卡片/引用逃逸（v0.16 反馈 #4）：光标位于 callout/blockquote 内最后一个节点且该段为空时，
 * Enter 或 ↓ 把光标移出容器、落到其下方新段落（容器内正常回车换行不受影响）。
 */
const ContainerEscape = Extension.create({
  name: 'containerEscape',
  addKeyboardShortcuts() {
    const escape = (): boolean => {
      const { state, view } = this.editor;
      const { $from, empty } = state.selection;
      if (!empty) return false;
      let depth = -1;
      for (let d = $from.depth; d > 0; d--) {
        const name = $from.node(d).type.name;
        if (name === 'callout' || name === 'blockquote') { depth = d; break; }
      }
      if (depth < 0) return false;
      const parentIsEmpty = $from.parent.type.isTextblock && $from.parent.content.size === 0;
      const isLastChild = $from.index(depth) === $from.node(depth).childCount - 1;
      if (!parentIsEmpty || !isLastChild) return false;
      const pos = $from.after(depth);
      const tr = state.tr.insert(pos, state.schema.nodes.paragraph!.create());
      tr.setSelection(TextSelection.create(tr.doc, pos + 1));
      view.dispatch(tr.scrollIntoView());
      return true;
    };
    return {
      Enter: () => escape(),
      ArrowDown: () => escape(),
    };
  },
});

export interface NotesEditorOpts {
  menuHost: CalloutMenuHost;
  placeholder: string;
  onUpdate(): void;
  onSelectionUpdate(): void;
}

export function createNotesEditor(host: HTMLElement, opts: NotesEditorOpts): Editor {
  return new Editor({
    element: host,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: false,   // 由 GbCodeBlock 接管（带语法高亮 + 语言标签 + 独立行号，v0.18 反馈 #7）
        horizontalRule: false,   // 由 GbHorizontalRule 接管（NodeView 承载删除按钮，v0.18 反馈 #9）
      }),
      // v0.18 反馈 #7：代码块视图（实时高亮 / 语言下拉 / 行号 / 删除按钮）
      GbCodeBlock.configure({ lowlight, defaultLanguage: 'plaintext', languageClassPrefix: 'lang-' }),
      GbHorizontalRule,
      CodeHotkey,
      TabInput,
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      FontFamily,
      Placeholder.configure({ placeholder: opts.placeholder }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true, lastColumnResizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Callout.configure({ menuHost: opts.menuHost }),
      Sketch,
      GbImage,
      ImageInput,
      ContainerEscape,
      ShowChars,
    ],
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    onUpdate: opts.onUpdate,
    onSelectionUpdate: opts.onSelectionUpdate,
  });
}

// ---------- 命令封装（工具栏与 / 菜单共用） ----------

export const setFontSize = (ed: Editor, px: number | null): boolean =>
  ed.chain().focus().setMark('textStyle', { fontSize: px ? `${px}px` : null }).run();

export const setFontFamilyName = (ed: Editor, name: string | null): boolean =>
  name ? ed.chain().focus().setFontFamily(name).run() : ed.chain().focus().unsetFontFamily().run();

export const insertTable = (ed: Editor, rows = 3, cols = 3): boolean =>
  ed.chain().focus().insertTable({ rows, cols, withHeaderRow: true }).run();

/** 插入卡片：始终在其后补一个空段落——光标可立即落到卡片下方（v0.16 反馈 #4） */
export const insertCalloutBlock = (ed: Editor, kind: string, title = ''): boolean =>
  ed.chain().focus().insertContent([
    { type: 'callout', attrs: { kind, title }, content: [{ type: 'paragraph' }] },
    { type: 'paragraph' },
  ]).run();

export const insertSketch = (ed: Editor): boolean =>
  ed.chain().focus().insertContent({ type: 'sketch' }).run();

export const insertTimestamp = (ed: Editor): boolean => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return ed.chain().focus().insertContent(s).run();
};

/** 光标在代码块内时返回其语言；否则 undefined（工具栏语言下拉联动） */
export function currentCodeLang(ed: Editor): string | undefined {
  const { $from } = ed.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'codeBlock') return String($from.node(d).attrs.language ?? 'plaintext');
  }
  return undefined;
}

export const setCodeLang = (ed: Editor, lang: string): boolean =>
  ed.chain().focus().updateAttributes('codeBlock', { language: lang }).run();

/** 大纲提取：H1–H4 顺序列表 */
export interface OutlineItem { level: number; text: string; pos: number }

export function extractOutline(ed: Editor): OutlineItem[] {
  const out: OutlineItem[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: Number(node.attrs.level) || 1, text: node.textContent, pos });
    }
    return true;
  });
  return out;
}

/** 光标当前所在 heading（大纲高亮用）：from 之前最近的 heading（含光标位于标题内） */
export function currentHeadingPos(ed: Editor): number | undefined {
  let found: number | undefined;
  const from = ed.state.selection.from;
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'heading' && pos <= from) found = pos;
    return true;
  });
  return found;
}

/** 滚动到指定 pos 的节点（大纲点击定位） */
export function scrollToPos(ed: Editor, pos: number): void {
  try {
    const dom = ed.view.nodeDOM(pos) as HTMLElement | undefined;
    (dom ?? ed.view.domAtPos(pos).node as HTMLElement)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  } catch { /* pos 越界时忽略 */ }
}
