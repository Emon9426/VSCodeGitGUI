/**
 * v0.18 反馈 #7：代码块增强视图。
 * - 高亮仍由 CodeBlockLowlight 的语法插件在 contentDOM 内渲染（本视图只包壳，不改高亮机制）；
 * - 右上角常驻语言标签，点击弹出语言菜单（setNodeMarkup 直写，不依赖光标位置）；
 * - 左侧独立行号（与 pre 行高 20px 严格对齐，MutationObserver 跟随内容增删行）；
 * - plaintext 且内容 ≥4 字符时防抖自动识别语言（highlightAuto，仅从 plaintext 升级，不覆盖手动选择）；
 * - v0.18 反馈 #9：光标位于代码块内时显示整块删除按钮（.cur 类）。
 */
import type { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { showMenu } from '../dialogs';
import { CODE_LANGS } from '../ui-bits';
import { mkNodeDelBtn } from './blockdel';

export const lowlight = createLowlight(common);

const LANG_NAME = new Map<string, string>(CODE_LANGS.map(([id, name]) => [String(id), String(name)]));

/**
 * plaintext 自动识别：lowlight.highlightAuto 在当前版本对短片段几乎必然误判（relevance≈2 的 css/ini），
 * 改用高精度确定性正则（宁缺毋滥，未命中保持纯文本）。
 */
const AUTO_RULES: [string, RegExp][] = [
  ['json', /^\s*[[{][\s\S]*[\]}]\s*$/],
  ['sql', /(^|\s)(select\s|insert\s+into\s|update\s+\S+\s+set\s|delete\s+from\s|create\s+(table|view|index)\s|alter\s+table\s|drop\s+table\s)/i],
  ['python', /(^|\n)\s*(def\s+\w+\s*\(|class\s+\w+\s*[:(]|from\s+\w+\s+import\s|import\s+\w+\s*$)/],
  ['bash', /(^|\n)\s*(#!\/bin\/(ba)?sh|echo\s|cd\s\S|npm\s+(run|install|test)|git\s+(commit|push|pull|checkout)|sudo\s)/],
  ['javascript', /\b(const|let|var)\s+\w+\s*=|\bfunction\s*\w*\s*\(|=>\s*\{?|\brequire\(\s*['"]|\bimport\s+\w+\s+from\s+['"]/],
  ['css', /^[.#@a-z][\w-]*\s*\{[^}]*:[^}]*;?\s*\}/m],
  ['markdown', /(^|\n)#{1,6}\s+\S/],
  ['xml', /^\s*<\?xml\s|<\/?[a-z][\w:-]*(\s+[\w:-]+="[^"]*")*\s*(\/?>)/],
];

function detectLang(text: string): string | undefined {
  const s = text.trim();
  if (s.length < 4) return undefined;
  for (const [lang, re] of AUTO_RULES) {
    if (re.test(s)) return lang;
  }
  return undefined;
}

export const GbCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, editor, getPos }: { node: any; editor: Editor; getPos: () => number | undefined }) => {
      const wrap = document.createElement('div');
      wrap.className = 'gb-code';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.className = 'hljs';
      pre.appendChild(code);

      const t = (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k);
      const bar = document.createElement('div');
      bar.className = 'gb-code-bar';
      const langBtn = document.createElement('button');
      langBtn.type = 'button';
      langBtn.className = 'gb-code-lang';
      const delBtn = mkNodeDelBtn(editor, getPos, t('notesDeleteBlock'));
      bar.append(langBtn, delBtn);

      const gutter = document.createElement('div');
      gutter.className = 'gb-code-ln';
      wrap.append(pre, gutter, bar);

      const curLang = (): string => String(node.attrs.language ?? 'plaintext');
      const refreshLang = (): void => {
        langBtn.textContent = LANG_NAME.get(curLang()) ?? curLang();
        // NodeView 下 renderHTML 不会作用到 DOM，语言类手动同步（与 languageClassPrefix 'lang-' 一致）
        const l = curLang();
        code.className = `hljs${l && l !== 'plaintext' ? ` lang-${l}` : ''}`;
      };
      refreshLang();

      // 独立行号：按换行数重建 span（行高与 pre 一致 20px，CSS 对齐）
      const renumber = (): void => {
        const lines = (code.textContent ?? '').split('\n').length || 1;
        if (gutter.childElementCount === lines) return;
        const spans: HTMLSpanElement[] = [];
        for (let i = 1; i <= lines; i++) {
          const s = document.createElement('span');
          s.textContent = String(i);
          spans.push(s);
        }
        gutter.replaceChildren(...spans);
      };
      renumber();
      const mo = new MutationObserver(() => { renumber(); scheduleAuto(); });
      mo.observe(code, { childList: true, characterData: true, subtree: true });

      /** 语言切换：光标不在块内也要生效 → setNodeMarkup 直写 */
      const setLang = (lang: string, manual: boolean): void => {
        const pos = getPos();
        if (typeof pos !== 'number') return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur) return;
        if (manual) userPinned = true;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, language: lang }));
      };
      let userPinned = false;
      langBtn.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); });
      langBtn.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        const r = langBtn.getBoundingClientRect();
        showMenu(CODE_LANGS.map(([id, name]) => ({
          label: String(name),
          run: () => setLang(String(id), true),
        })), r.left, r.bottom);
      });

      // 光标进出代码块 → 删除按钮显隐（挂在按钮自身：PM 会整体重写 NodeView 根元素 class，
      // 手动加在 wrap 上的状态类会被装饰同步抹掉）
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

      // plaintext 自动识别（防抖；仅当前仍是 plaintext 且用户未手动选过语言时升级）
      let autoTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleAuto = (): void => {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = setTimeout(() => {
          autoTimer = undefined;
          if (userPinned) return;
          const pos = getPos();
          if (typeof pos !== 'number') return;
          const cur = editor.state.doc.nodeAt(pos);
          if (!cur || String(cur.attrs.language ?? 'plaintext') !== 'plaintext') return;
          const lang = detectLang(code.textContent ?? '');
          if (lang) setLang(lang, false);
        }, 600);
      };
      scheduleAuto();

      return {
        dom: wrap,
        contentDOM: code,
        update(newNode: any) {
          if (newNode.type.name !== 'codeBlock') return false;
          node = newNode;
          refreshLang();
          return true;
        },
        ignoreMutation(m: any) {
          return m.target === gutter || gutter.contains(m.target) || m.target === bar || bar.contains(m.target);
        },
        destroy() {
          mo.disconnect();
          editor.off('transaction', syncSel);
          editor.off('selectionUpdate', syncSel);
          if (autoTimer) clearTimeout(autoTimer);
        },
      };
    };
  },
});
