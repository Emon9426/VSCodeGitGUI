/**
 * 快速笔记 webview 入口（v0.16）：三栏装配、工具栏（颜色/高亮色/emoji/代码语言/显示字符/
 * 背景图案/字体）、/ 菜单、AI 编辑差异预览、自动保存、导出管线、文档背景与默认字体。
 * 与 Git 主面板零共享状态：独立 bundle（out/notes.js），仅复用 rpc/envelope 与 i18n 字典。
 */
import './styles/notes.css';
import type { Editor } from '@tiptap/core';
import { createT, type Lang, type Translate } from '../../common/i18n';
import type { CalloutKind, NoteBg, NoteMeta, NotesEvent, NotesResponse } from '../../common/notesProtocol';
import { DEFAULT_NOTE_BG } from '../../common/notesProtocol';
import { rpc, handleResponse, postRaw } from '../rpc';
import { el, clearChildren } from '../util';
import { createFileList, type NotesFileListHost } from './fileList';
import { createOutline } from './outline';
import { createSlashMenu, buildSlashItems, type SlashItem } from './slash';
import { showMenu, showPrompt, showConfirm } from './dialogs';
import {
  createNotesEditor, extractOutline, currentHeadingPos, scrollToPos,
  setFontSize, setFontFamilyName, insertCalloutBlock, insertSketch, insertTimestamp,
  insertTable, currentCodeLang, setCodeLang,
  FONT_SIZES,
} from './editor/setup';
import { CALLOUT_KINDS } from './editor/callout';
import { setShowChars } from './chars';
import { buildColorGrid, buildEmojiPanel, CODE_LANGS, TEXT_COLOR_LIST, HIGHLIGHT_LIST, listSystemFonts } from './ui-bits';

// ---------- 状态 ----------
let t: Translate = createT('zh-CN');
let ed: Editor;
let dir = '';
let notes: NoteMeta[] = [];
let activeId: string | undefined;
let activeTitle = '';
let dirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let aiBusy = false;
let aiText = '';
let aiRange: { from: number; to: number } | undefined;
let bg: NoteBg = { ...DEFAULT_NOTE_BG };
let fontZh = '微软雅黑';
let fontEn = 'Segoe UI';
let showCharsOn = false;
let systemFonts: string[] | undefined;
let showLnOn = false;          // v0.17 反馈 #9：行号显示
let lnBtn: HTMLElement | undefined;

const rpcq = (cmd: string, args?: Record<string, unknown>): Promise<any> => rpc(cmd, args);

// ---------- DOM 骨架 ----------
const root = document.getElementById('notes-app')!;
const app = el('div', 'n-app');
const titlebar = el('div', 'n-titlebar');
const toolbar = el('div', 'n-toolbar');
const editorHost = el('div', 'n-editor');
// v0.17 反馈 #2：文档标题头（大标题 + 上次修改时间 + 专用分割线），与正文普通 H1/hr 区分
const docHead = el('div', 'n-dochead');
const docTitle = el('input', 'n-doc-title') as HTMLInputElement;
const docMeta = el('div', 'n-doc-meta');
docHead.append(docTitle, docMeta, el('div', 'n-doc-titleline'));
const gutter = el('div', 'gg-ln-gutter hidden');
const doc = el('div', 'n-doc');
editorHost.append(docHead, doc, gutter);
const main = el('div', 'n-main');
main.append(titlebar, toolbar, editorHost);
app.append(main);
root.appendChild(app);

docTitle.addEventListener('input', () => {
  activeTitle = docTitle.value;
  markDirty();
  refreshTitlebar();
});
docTitle.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); ed?.commands.focus('start'); }
});

let fileList: ReturnType<typeof createFileList>;
let outline: ReturnType<typeof createOutline>;

/** 上次修改时间（标题头 meta 行） */
function setDocMeta(at?: number): void {
  if (!at) { docMeta.textContent = ''; return; }
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  docMeta.textContent = `${t('notesLastModified')} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 旧文档标题迁移：首个 H1 是旧版标题约定 → 剥离为标题头内容，不再留在正文里。
 */
function splitTitleDoc(docJson: unknown): { title: string; doc: unknown } {
  const d = docJson as { content?: { type?: string; attrs?: { level?: number }; content?: { type?: string; text?: string }[] }[] } | undefined;
  const first = d?.content?.[0];
  if (first?.type === 'heading' && Number(first.attrs?.level) === 1) {
    const text = (first.content ?? []).filter(c => c.type === 'text').map(c => c.text ?? '').join('').trim();
    const rest = (d!.content ?? []).slice(1);
    return { title: text, doc: { ...d, content: rest.length ? rest : [{ type: 'paragraph' }] } };
  }
  return { title: '', doc: docJson };
}

// ---------- 保存 ----------
const timeStr = (at: number): string => {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
function setSaveState(state: 'dirty' | 'saved', at?: number): void {
  const elx = document.getElementById('n-save');
  if (!elx) return;
  elx.textContent = state === 'dirty' ? `● ${t('notesUnsaved')}` : `✓ ${t('notesSavedAt', { time: timeStr(at ?? Date.now()) })}`;
}

function markDirty(): void {
  if (aiBusy) return;
  dirty = true;
  setSaveState('dirty');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), 800);
}

async function save(): Promise<void> {
  if (!dirty || aiBusy) return;
  const title = docTitle.value.trim() || firstHeadingText() || activeTitle || t('notesUntitledDefault');
  if (!activeId) {
    const meta = await rpc('notes.create', { title });
    activeId = meta.id;
    activeTitle = meta.title;
  }
  try {
    const r = await rpc('notes.save', { id: activeId, doc: ed.getJSON(), title, bg });
    dirty = false;
    activeTitle = title;
    setSaveState('saved', r.savedAt);
    setDocMeta(r.savedAt);
    fileList.setActive(activeId);
  } catch (e) {
    toast('error', t('notesSaveFailed', { msg: String((e as Error)?.message ?? e) }));
  }
}

function firstHeadingText(): string {
  let out = '';
  ed.state.doc.descendants(node => {
    if (node.type.name === 'heading') { out = node.textContent.trim(); return false; }
    return true;
  });
  return out.slice(0, 60);
}

function toast(level: 'info' | 'warn' | 'error', message: string): void {
  if (!message) return;
  const bar = el('div', `gg-toast ${level}`, message);
  document.body.appendChild(bar);
  setTimeout(() => bar.classList.add('show'), 10);
  setTimeout(() => { bar.classList.remove('show'); setTimeout(() => bar.remove(), 300); }, level === 'info' ? 2600 : 5000);
}

// ---------- 背景应用 ----------
function applyBg(): void {
  editorHost.style.background = bg.color;
  editorHost.classList.toggle('pat-grid', bg.pattern === 'grid');
  editorHost.classList.toggle('pat-line', bg.pattern === 'line');
}

// ---------- 默认字体应用 ----------
function applyFonts(): void {
  editorHost.style.setProperty('--n-font-en', `'${fontEn.replace(/'/g, '')}'`);
  editorHost.style.setProperty('--n-font-zh', `'${fontZh.replace(/'/g, '')}'`);
}

// ---------- 打开 / 切换 ----------
async function openNote(id: string): Promise<void> {
  await flushSave();
  try {
    const r = await rpc('notes.read', { id });
    activeId = r.meta.id;
    bg = r.bg ?? { ...DEFAULT_NOTE_BG };
    const split = splitTitleDoc(r.doc);
    activeTitle = split.title || r.meta.title || t('notesUntitledDefault');
    docTitle.value = split.title || (r.meta.title === t('notesUntitledDefault') ? '' : r.meta.title);
    setDocMeta(r.meta.updated);
    ed.commands.setContent(split.doc as any);
    applyBg();
    dirty = false;
    fileList.setActive(activeId);
    refreshTitlebar();
    refreshOutline();
  } catch (e) {
    toast('error', t('notesLoadFailed', { msg: String((e as Error)?.message ?? e) }));
  }
}

async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
  if (dirty && activeId) await save();
}

function newNote(): void {
  void (async () => {
    await flushSave();
    const meta = await rpc('notes.create', { title: t('notesUntitledDefault') });
    activeId = meta.id;
    activeTitle = meta.title;
    bg = { ...DEFAULT_NOTE_BG };
    applyBg();
    docTitle.value = '';
    setDocMeta(Date.now());
    ed.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
    dirty = false;
    fileList.setActive(activeId);
    refreshTitlebar();
    refreshOutline();
    setSaveState('saved', Date.now());
    docTitle.focus();
    docTitle.select();
  })();
}

function refreshTitlebar(): void {
  document.title = `${docTitle.value.trim() || activeTitle || t('notesUntitledDefault')} — ${t('notesApp')}`;
}

// ---------- 工具栏 ----------
interface TBtn { icon?: string; svg?: string; cls?: string; label: string; run(): void; dropdown?: HTMLElement }

const SKETCH_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.2" y="4.2" width="8.2" height="8.2" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="9.6" y="2" width="5.2" height="5.2" rx="1" fill="currentColor" opacity="0.55"/></svg>';
const BG_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 10 L6.5 5.5 L14 13" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
// v0.17 反馈 #3/#5：emoji 在部分 webview 环境渲染为破损占位符，按钮图标全部改受控内联 SVG
const EMOJI_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.7" cy="6.6" r="1" fill="currentColor"/><circle cx="10.3" cy="6.6" r="1" fill="currentColor"/><path d="M5.2 9.7 Q8 12.1 10.8 9.7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const MARK_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 13.4 L3.4 10.5 L10.3 3.6 a1.7 1.7 0 0 1 2.4 2.4 L5.8 12.9 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9.2 4.8 L11.7 7.3" stroke="currentColor" stroke-width="1.2"/></svg>';
const IMG_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5.2" cy="6" r="1.2" fill="currentColor"/><path d="M2 12.2 L6.5 7.6 L9.5 10.5 L11.4 8.8 L14 11.3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>';
// v0.18 反馈 #2：⌗ 字形在中英混排基线中偏高，与其他按钮不齐，换受控 SVG
const INLINE_CODE_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.6 4.7 L2.6 8 L5.6 11.3 M10.4 4.7 L13.4 8 L10.4 11.3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function mkBtn(b: TBtn): HTMLElement {
  const btn = el('button', 'gg-tbtn' + (b.dropdown ? ' has-dd' : '') + (b.cls ? ' ' + b.cls : '')) as HTMLButtonElement;
  if (b.svg) btn.innerHTML = b.svg;   // 受控常量 SVG，非用户输入
  else btn.textContent = b.icon ?? '';
  if (b.dropdown) btn.appendChild(el('span', 'dd', '▾'));
  btn.title = b.label;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (b.dropdown) { openDropdown(btn, b.dropdown); return; }
    b.run();
    ed.view.focus();
  });
  return btn;
}

/** 在按钮下方打开浮层（同时关闭其他已开浮层；点击外部关闭） */
function openDropdown(btn: HTMLElement, menu: HTMLElement): void {
  for (const other of document.querySelectorAll('.gg-toolbar-menu:not(.hidden), .gg-emoji-panel')) {
    const host = other.parentElement;
    void host;
    other.classList.add('hidden');
  }
  if (!menu.parentElement) document.body.appendChild(menu);
  menu.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  const closeOnce = (ev: PointerEvent): void => {
    if (!menu.contains(ev.target as Node) && ev.target !== btn && !btn.contains(ev.target as Node)) {
      menu.classList.add('hidden');
      document.removeEventListener('pointerdown', closeOnce, true);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeOnce, true), 0);
}

function menuEl(items: { label?: string; el?: HTMLElement; run?(): void }[]): HTMLElement {
  const m = el('div', 'gg-toolbar-menu hidden');
  for (const it of items) {
    if (it.el) {
      m.appendChild(it.el);
      continue;
    }
    const row = el('div', 'gg-menu-item', it.label ?? '');
    row.addEventListener('click', () => { it.run?.(); m.classList.add('hidden'); ed.view.focus(); });
    m.appendChild(row);
  }
  return m;
}

const H_LEVELS = [1, 2, 3, 4];
const CALLOUT_ICONS: Record<string, string> = { info: 'ℹ️', ok: '✅', warn: '⚠️', danger: '⛔', note: '📝' };
const BG_PRESETS: { color: string; label: string }[] = [
  { color: '#FAF9DE', label: '护眼黄（默认）' },
  { color: '#CCE8CF', label: '豆沙绿' },
  { color: '#F5E8C8', label: '羊皮纸' },
  { color: '#E8EEF7', label: '雾蓝' },
  { color: '#F2F2F2', label: '浅灰' },
  { color: '#FFFFFF', label: '白' },
];
const BG_PATTERNS: { id: NoteBg['pattern']; label: string }[] = [
  { id: 'none', label: '无图案' },
  { id: 'grid', label: '方格纹' },
  { id: 'line', label: '横线' },
];

function buildToolbar(): void {
  const grp = (items: HTMLElement[]): HTMLElement => {
    const g = el('span', 'gg-tgroup');
    g.append(...items);
    return g;
  };
  const colorA = el('span', 'gg-color-under', 'A');
  colorA.appendChild(el('i', 'gg-color-bar'));

  toolbar.append(
    grp([
      mkBtn({ icon: '⟲', label: '撤销', run: () => ed.chain().focus().undo().run() }),
      mkBtn({ icon: '⟳', label: '重做', run: () => ed.chain().focus().redo().run() }),
      mkBtn({ icon: 'B', cls: 'b', label: '加粗 (Ctrl+B)', run: () => ed.chain().focus().toggleBold().run() }),
      mkBtn({ icon: 'I', cls: 'i', label: '斜体 (Ctrl+I)', run: () => ed.chain().focus().toggleItalic().run() }),
      mkBtn({ icon: 'U', cls: 'u', label: '下划线 (Ctrl+U)', run: () => ed.chain().focus().toggleUnderline().run() }),
      mkBtn({ icon: 'S', cls: 's', label: '删除线', run: () => ed.chain().focus().toggleStrike().run() }),
      mkBtn({ svg: INLINE_CODE_SVG, label: '行内代码 (Ctrl+M)', run: () => ed.chain().focus().toggleCode().run() }),
      mkBtn({
        icon: 'A', cls: 'color-btn', label: '文字颜色',
        run: () => ed.chain().focus().unsetColor().run(),
        dropdown: menuEl([{
          el: buildColorGrid(TEXT_COLOR_LIST, '', true, c => {
            if (c) ed.chain().focus().setColor(c).run(); else ed.chain().focus().unsetColor().run();
            markDirty();
          }, () => { /* 菜单自关 */ }),
        }]),
      }),
      mkBtn({
        svg: MARK_SVG, label: '高亮颜色',
        run: () => ed.chain().focus().unsetHighlight().run(),
        dropdown: menuEl([{
          el: buildColorGrid(HIGHLIGHT_LIST, '', true, c => {
            if (c) ed.chain().focus().setHighlight({ color: c }).run(); else ed.chain().focus().unsetHighlight().run();
            markDirty();
          }, () => { /* 菜单自关 */ }),
        }]),
      }),
    ]),
    grp([
      mkBtn({
        icon: 'H', label: '标题', run: () => ed.chain().focus().setParagraph().run(),
        dropdown: menuEl([
          { label: '正文', run: () => ed.chain().focus().setParagraph().run() },
          ...H_LEVELS.map(l => ({ label: `H${l}`, run: () => ed.chain().focus().toggleHeading({ level: l as 1 | 2 | 3 | 4 }).run() })),
        ]),
      }),
      mkBtn({
        icon: '•—', label: '列表',
        run: () => ed.chain().focus().toggleBulletList().run(),
        dropdown: menuEl([
          { label: '• 无序列表', run: () => ed.chain().focus().toggleBulletList().run() },
          { label: '1. 有序列表', run: () => ed.chain().focus().toggleOrderedList().run() },
          { label: '☑ 待办列表', run: () => ed.chain().focus().toggleTaskList().run() },
        ]),
      }),
      mkBtn({
        icon: '▤', label: '卡片',
        run: () => insertCalloutBlock(ed, 'info'),
        dropdown: menuEl(CALLOUT_KINDS.map(k => ({
          label: `${CALLOUT_ICONS[k.kind]} ${k.kind}`,
          run: () => insertCalloutBlock(ed, k.kind as CalloutKind),
        }))),
      }),
      mkBtn({
        icon: '▦', label: '表格（光标在表格内时选择语言=应用）', run: () => insertTable(ed),
        dropdown: menuEl([
          { label: '插入 3×3 表格', run: () => insertTable(ed) },
          { label: '合并单元格', run: () => ed.chain().focus().mergeCells().run() },
          { label: '拆分单元格', run: () => ed.chain().focus().splitCell().run() },
          { label: '切换表头行', run: () => ed.chain().focus().toggleHeaderRow().run() },
        ]),
      }),
      mkBtn({
        icon: '</>', label: '代码块（选择语言插入；光标在代码块内=切换语言）', run: () => ed.chain().focus().toggleCodeBlock().run(),
        dropdown: menuEl(CODE_LANGS.map(([id, name]) => ({
          label: name,
          run: () => {
            if (currentCodeLang(ed) !== undefined) setCodeLang(ed, id);
            else ed.chain().focus().toggleCodeBlock().run() && setCodeLang(ed, id);
          },
        }))),
      }),
      mkBtn({ svg: SKETCH_SVG, label: '画板（流程图）', run: () => insertSketch(ed) }),
      mkBtn({ icon: '—', label: '分割线', run: () => ed.chain().focus().setHorizontalRule().run() }),
      mkBtn({ icon: '❝', label: '引用', run: () => ed.chain().focus().toggleBlockquote().run() }),
    ]),
    grp([
      mkBtn({
        svg: EMOJI_SVG, label: 'Emoji',
        run: () => undefined,
        dropdown: menuEl([{
          el: buildEmojiPanel(ch => { ed.chain().focus().insertContent(ch).run(); markDirty(); }, () => { /* 自关 */ }),
        }]),
      }),
      // v0.17 反馈 #7：插入图片（系统对话框 → data URL 内嵌；粘贴/拖放亦可）
      mkBtn({ svg: IMG_SVG, label: t('notesInsertImage'), run: () => void insertImageFlow() }),
      (() => {
        const b = mkBtn({
          icon: '¶', label: '显示所有字符（空格 · 制表 → 段尾 ¶）',
          run: () => {
            showCharsOn = !showCharsOn;
            setShowChars(ed.view, showCharsOn);
            b.classList.toggle('on', showCharsOn);
          },
        });
        return b;
      })(),
      // v0.17 反馈 #9：行号显示（一个段落/画板/图片/卡片 = 1 行）
      (() => {
        const b = mkBtn({
          icon: '#', label: t('notesShowLineNums'),
          run: () => toggleLn(),
        });
        lnBtn = b;
        return b;
      })(),
    ]),
    grp([
      mkBtn({
        icon: '字体', label: '字体（底部可设默认中/英字体）',
        run: () => setFontFamilyName(ed, null),
        dropdown: buildFontMenu(),
      }),
      mkBtn({
        icon: '13', label: '字号',
        run: () => setFontSize(ed, null),
        dropdown: menuEl([
          { label: '默认', run: () => setFontSize(ed, null) },
          ...FONT_SIZES.map(n => ({ label: `${n}px`, run: () => setFontSize(ed, n) })),
        ]),
      }),
      mkBtn({
        svg: BG_SVG, label: '文档背景（颜色与图案）',
        run: () => undefined,
        dropdown: buildBgMenu(),
      }),
    ]),
    grp([
      // v0.17 反馈 #3：移除"插入命令 /"按钮（保留行首输入 / 呼出）
      (() => {
        const b = mkBtn({ icon: '✦ AI', label: t('notesAiMenu'), run: () => openAi() });
        b.classList.add('ai-btn');
        return b;
      })(),
    ]),
  );
  void colorA;
}

let fontMenu: HTMLElement | undefined;
function buildFontMenu(): HTMLElement {
  if (fontMenu) return fontMenu;
  fontMenu = menuEl([]);
  void listSystemFonts().then(({ all, viaApi }) => {
    systemFonts = all;
    rebuildFontMenu(all, viaApi);
  });
  return fontMenu;
}

function rebuildFontMenu(fonts: string[], viaApi: boolean): void {
  const menu = fontMenu;
  if (!menu) return;
  menu.replaceChildren();
  const addItem = (label: string, run: () => void): void => {
    const row = el('div', 'gg-menu-item');
    row.textContent = label;
    row.style.fontFamily = `'${label}', monospace`;
    row.addEventListener('click', () => { run(); menu.classList.add('hidden'); ed.view.focus(); });
    menu.appendChild(row);
  };
  const addSep = (label: string): void => {
    menu.appendChild(el('div', 'gg-menu-group', label));
  };
  addSep(viaApi ? '系统字体' : '常用字体');
  for (const f of fonts.slice(0, 80)) {
    addItem(f, () => { setFontFamilyName(ed, f); markDirty(); });
  }
  addSep('默认');
  addItem(`默认（英文 ${fontEn} · 中文 ${fontZh}）`, () => setFontFamilyName(ed, null));
  addSep('设为默认（新文档与正文默认生效）');
  const rowZh = el('div', 'gg-menu-item', '🇨🇳 将选中字体设为默认中文字体');
  rowZh.addEventListener('click', () => {
    void pickFontForDefault().then(f => {
      if (!f) return;
      void rpc('notes.setDefFont', { script: 'zh', family: f }).then(r2 => {
        fontZh = r2.zh; fontEn = r2.en; applyFonts();
        rebuildFontMenu(systemFonts ?? [fontEn], false);
        toast('info', `默认中文字体：${f}`);
      });
    });
    fontMenu!.classList.add('hidden');
  });
  const rowEn = el('div', 'gg-menu-item', '🇺🇸 将选中字体设为默认英文字体');
  rowEn.addEventListener('click', () => {
    void pickFontForDefault().then(f => {
      if (!f) return;
      void rpc('notes.setDefFont', { script: 'en', family: f }).then(r2 => {
        fontZh = r2.zh; fontEn = r2.en; applyFonts();
        rebuildFontMenu(systemFonts ?? [fontZh], false);
        toast('info', `默认英文字体：${f}`);
      });
    });
    fontMenu!.classList.add('hidden');
  });
  fontMenu!.append(rowZh, rowEn);
}
/** 设为默认时先让用户从系统字体中选一个（二级菜单简化为输入当前已有列表） */
function pickFontForDefault(): Promise<string | null> {
  return showPrompt('设为默认字体', '字体名（与字体下拉中名称一致）', fontZh);
}

let bgMenu: HTMLElement | undefined;
function buildBgMenu(): HTMLElement {
  if (bgMenu) return bgMenu;
  bgMenu = el('div', 'gg-toolbar-menu hidden');
  const rebuild = (): void => {
    bgMenu!.replaceChildren();
    bgMenu!.appendChild(el('div', 'gg-menu-group', '颜色'));
    const grid = buildColorGrid(BG_PRESETS.map(p => p.color), bg.color, false, c => {
      if (c) { bg.color = c; applyBg(); markDirty(); }
    }, () => { bgMenu!.classList.add('hidden'); });
    // 颜色格子带上预设名提示
    const cells = grid.querySelectorAll('.gg-color-cell');
    BG_PRESETS.forEach((p, i) => { (cells[i] as HTMLElement)?.setAttribute('title', p.label); });
    bgMenu!.appendChild(grid);
    bgMenu!.appendChild(el('div', 'gg-menu-group', '图案'));
    for (const p of BG_PATTERNS) {
      const row = el('div', `gg-menu-item${bg.pattern === p.id ? ' on' : ''}`, p.label);
      row.addEventListener('click', () => {
        bg.pattern = p.id;
        applyBg(); markDirty();
        rebuild();
      });
      bgMenu!.appendChild(row);
    }
  };
  rebuild();
  return bgMenu;
}

// ---------- / 菜单 ----------
let slash: ReturnType<typeof createSlashMenu> | undefined;

/** 视口坐标 → editorHost 内容坐标（v0.17：editorHost 改 position:relative，浮层随内容坐标系） */
function toHostXY(clientX: number, clientY: number): { x: number; y: number } {
  const r = editorHost.getBoundingClientRect();
  return { x: clientX - r.left + editorHost.scrollLeft, y: clientY - r.top + editorHost.scrollTop };
}

function openSlashAtSelection(): void {
  const coords = ed.view.coordsAtPos(ed.state.selection.from);
  const p = toHostXY(coords.left, coords.bottom);
  slash?.open(p.x, p.y);
}

// ---------- 插图（v0.17 反馈 #7） ----------
async function insertImageFlow(): Promise<void> {
  try {
    const r = await rpc('notes.pickImage');
    if (!r?.dataUrl) return;
    ed.chain().focus().insertGbImage({ src: String(r.dataUrl), alt: String(r.name ?? 'image') }).run();
    markDirty();
    toast('info', t('notesImageInserted', { name: String(r.name ?? 'image') }));
  } catch (e) {
    toast('error', String((e as Error)?.message ?? e));
  }
}

// ---------- 行号（v0.17 反馈 #9：顶级块 = 1 行） ----------
function toggleLn(force?: boolean): void {
  showLnOn = force ?? !showLnOn;
  try { localStorage.setItem('gbNotes.ln', showLnOn ? '1' : '0'); } catch { /* 隐私模式等忽略 */ }
  editorHost.classList.toggle('ln-on', showLnOn);
  gutter.classList.toggle('hidden', !showLnOn);
  lnBtn?.classList.toggle('on', showLnOn);
  if (showLnOn) renumber();
}

function renumber(): void {
  if (!showLnOn || !ed) return;
  clearChildren(gutter);
  gutter.style.height = `${doc.offsetTop + doc.offsetHeight}px`;
  let i = 0;
  const add = (top: number): void => {
    i++;
    const num = el('span', 'gg-ln-num', String(i));
    num.style.top = `${top + 2}px`;
    gutter.appendChild(num);
  };
  for (const child of Array.from(ed.view.dom.children)) {
    const c = child as HTMLElement;
    if (c.tagName === 'BR' || c.classList.contains('ProseMirror-gapcursor')) continue;
    // v0.18 反馈 #1：表格每个表格行（tr）一行；代码块有独立行号，整体仍算 1 行；
    // 图片/画板/卡片等块级元素各算 1 行（行号槽对齐块顶）
    if (c.tagName === 'TABLE' || c.classList.contains('tableWrapper')) {
      const table = c.tagName === 'TABLE' ? c : c.querySelector(':scope > table');
      const rows = table?.querySelectorAll('tr');
      if (rows?.length) { for (const r of rows) add((r as HTMLElement).offsetTop); continue; }
    }
    add(c.offsetTop);
  }
}

/** 行首输入 "/" 呼出（onUpdate 内检查） */
function checkSlashTrigger(): void {
  const { from, empty } = ed.state.selection;
  if (!empty) return;
  const textBefore = ed.state.doc.textBetween(Math.max(0, from - 1), from, '\n');
  if (textBefore === '/') {
    ed.chain().focus().deleteRange({ from: from - 1, to: from }).run();
    openSlashAtSelection();
  }
}

// ---------- AI 编辑 ----------
let aiPop: HTMLElement;
let aiOld = '';
let aiResultBox: HTMLElement;
let aiNewBox: HTMLElement;

function openAi(): void {
  const { from, to, empty } = ed.state.selection;
  if (empty) { toast('warn', t('notesAiMenu') + ': ' + t('notesSketchTip')); return; }
  aiOld = ed.state.doc.textBetween(from, to, '\n');
  aiRange = { from, to };
  aiText = '';
  aiNewBox.textContent = '';
  aiResultBox.classList.add('hidden');
  aiPop.classList.remove('hidden');
  // v0.17 反馈 #4：默认停靠编辑区右上角（不压正文中部光标处）；用户拖动过的位置持久记忆
  let pos: { l: number; t: number } | undefined;
  try { pos = JSON.parse(localStorage.getItem('gbNotes.aiPos') ?? '') as { l: number; t: number } | undefined; } catch { pos = undefined; }
  if (pos && typeof pos.l === 'number' && typeof pos.t === 'number') {
    // 记忆位置若已滚出视野，回落到当前可视区右上
    const off = pos.t - editorHost.scrollTop;
    if (off >= 0 && off <= editorHost.clientHeight - 80) placeAi(pos.l, pos.t);
    else placeAi(pos.l, editorHost.scrollTop + 12);
  } else {
    placeAi(Math.max(8, editorHost.clientWidth - 352), editorHost.scrollTop + 12);
  }
}

/** AI 浮层落点（限制在编辑区内） */
function placeAi(left: number, top: number): void {
  const maxX = Math.max(0, editorHost.clientWidth - aiPop.offsetWidth - 8);
  const maxY = Math.max(0, editorHost.scrollTop + editorHost.clientHeight - 80);
  aiPop.style.left = `${Math.max(0, Math.min(left, maxX))}px`;
  aiPop.style.top = `${Math.max(0, Math.min(top, maxY))}px`;
}

function aiClose(): void { aiPop.classList.add('hidden'); }

async function aiRun(action: string, custom = ''): Promise<void> {
  if (!aiRange || aiBusy) return;
  aiBusy = true;
  aiText = '';
  aiNewBox.textContent = t('notesAiBusy');
  aiResultBox.classList.remove('hidden');
  try {
    const r = await rpc('notes.ai', { action, text: aiOld, custom });
    aiNewBox.textContent = r.text;
  } catch (e) {
    aiNewBox.textContent = '';
    toast('error', String((e as Error)?.message ?? e));
    aiBusy = false;
    return;
  }
  aiBusy = false;
  aiNewBox.textContent = aiText || t('notesAiDone');
}

function aiAccept(replace: boolean): void {
  if (!aiRange || !aiText) return;
  const { from, to } = aiRange;
  if (replace) ed.chain().focus().insertContentAt({ from, to }, aiText).run();
  else ed.chain().focus().insertContentAt(to, '\n' + aiText).run();
  aiRange = undefined;
  aiClose();
  markDirty();
}

// ---------- 卡片类型菜单（Callout NodeView 回调） ----------
const calloutMenuHost = {
  showKindMenu(x: number, y: number, current: string, onPick: (k: CalloutKind) => void): void {
    showMenu(CALLOUT_KINDS.filter(k => k.kind !== current).map(k => ({
      label: `${CALLOUT_ICONS[k.kind]} ${k.kind}`,
      run: () => onPick(k.kind),
    })), x, y);
  },
};

// ---------- 导出 ----------
function doExport(fmt: 'md' | 'html' | 'pdf', saveAs: boolean): void {
  void (async () => {
    await flushSave();
    const payload = { id: activeId, doc: ed.getJSON(), title: activeTitle || firstHeadingText() || t('notesUntitledDefault'), fmt, htmlBody: fmt === 'md' ? '' : ed.getHTML(), bg };
    const cmd = saveAs ? 'notes.saveAs' : 'notes.export';
    await rpc(cmd, payload);
  })();
}

// ---------- 装配 ----------
function refreshOutline(): void {
  outline.setItems(extractOutline(ed));
}

function buildShell(): void {
  const notesListHost: NotesFileListHost = {
    create: newNote,
    open: (id) => void openNote(id),
    rename: (id, title) => void (async () => {
      const meta = await rpc('notes.rename', { id, title });
      if (id === activeId) { activeId = meta.id; activeTitle = meta.title; refreshTitlebar(); }
    })(),
    remove: (id) => void (async () => {
      const ok = await showConfirm(t('notesDeleteTitle'), t('notesDeleteConfirm', { name: notes.find(n => n.id === id)?.title ?? id }), t('notesDeleteTitle'), true);
      if (!ok) return;
      if (id === activeId) {
        activeId = undefined;
        dirty = false;
        docTitle.value = '';
        setDocMeta();
        ed.commands.setContent({ type: 'doc', content: [{ type: 'paragraph' }] });
      }
      await rpc('notes.delete', { id });
      fileList.setActive(activeId);
      toast('info', t('notesDeleted', { name: id }));
    })(),
    pickDir: () => void rpc('notes.pickDir').then((r: { dir: string } | null) => {
      if (r?.dir) toast('info', t('notesDirChanged', { dir: r.dir }));
    }),
    revealFM: () => { if (activeId) void rpcq('notes.revealInFM', { id: activeId }); },
    contextMenu: (x, y, note) => {
      if (!note) return;
      showMenu([
        { label: '✏️ ' + t('notesRenameTitle'), run: () => void showPrompt(t('notesRenameTitle'), t('notesRenameLabel'), note.title).then(v => { if (v) notesListHost.rename(note.id, v); }) },
        { label: '🗑 ' + t('notesDeleteTitle'), danger: true, run: () => notesListHost.remove(note.id) },
        { label: '↗ ' + t('notesRevealFM'), run: () => void rpc('notes.revealInFM', { id: note.id }) },
      ], x, y);
    },
  };
  fileList = createFileList(t, notesListHost);
  outline = createOutline(t, pos => scrollToPos(ed, pos));

  const saveState = el('span', 'n-save', '');
  saveState.id = 'n-save';
  const exportBtn = el('button', 'gg-tbtn dd-btn', `${t('notesExportTitle')} ▾`) as HTMLButtonElement;
  const exportMenu = menuEl([
    { label: '⬇️ ' + t('notesExportMd'), run: () => doExport('md', false) },
    { label: '🌐 ' + t('notesExportHtml'), run: () => doExport('html', false) },
    { label: '📄 ' + t('notesExportPdf'), run: () => doExport('pdf', false) },
    { label: '💾 ' + t('notesSaveAs'), run: () => doExport('html', true) },
    { label: '↗ ' + t('notesRevealFM'), run: () => { if (activeId) void rpc('notes.revealInFM', { id: activeId }); } },
  ]);
  exportBtn.addEventListener('click', e => {
    e.stopPropagation();
    openDropdown(exportBtn, exportMenu);
  });
  const tbRight = el('span', 'n-titlebar-right');
  tbRight.append(saveState, exportBtn);
  titlebar.append(tbRight);

  app.insertBefore(fileList.el, main);
  app.appendChild(outline.el);

  // AI 浮层
  aiPop = el('div', 'gg-ai-pop hidden');
  // v0.17 反馈 #4：可拖动标题栏（拖动位置持久记忆；默认停靠编辑区右上）
  const aiHead = el('div', 'gg-ai-head');
  aiHead.appendChild(el('span', 'gg-ai-head-t', `✦ ${t('notesAiMenu')}`));
  aiHead.appendChild(el('span', 'gg-ai-head-grip', '⤧'));
  let aiDrag: { sx: number; sy: number; ox: number; oy: number } | undefined;
  aiHead.addEventListener('pointerdown', e => {
    if ((e.target as HTMLElement).closest('button,input')) return;
    aiDrag = { sx: e.clientX, sy: e.clientY, ox: aiPop.offsetLeft, oy: aiPop.offsetTop };
    try { aiHead.setPointerCapture(e.pointerId); } catch { /* 合成事件/失焦时无活动指针，window 监听兜底 */ }
    e.preventDefault();
  });
  window.addEventListener('pointermove', e => {
    if (!aiDrag) return;
    placeAi(aiDrag.ox + e.clientX - aiDrag.sx, aiDrag.oy + e.clientY - aiDrag.sy);
  });
  const endAiDrag = (): void => {
    if (!aiDrag) return;
    aiDrag = undefined;
    try { localStorage.setItem('gbNotes.aiPos', JSON.stringify({ l: aiPop.offsetLeft, t: aiPop.offsetTop })); } catch { /* ignore */ }
  };
  window.addEventListener('pointerup', endAiDrag);
  window.addEventListener('pointercancel', endAiDrag);
  const acts = el('div', 'gg-ai-acts');
  const mkAct = (label: string, action: string): HTMLElement => {
    const b = el('button', 'gg-ai-act', label) as HTMLButtonElement;
    b.addEventListener('click', () => void aiRun(action));
    return b;
  };
  acts.append(
    mkAct(t('notesAiContinuation'), 'continue'), mkAct(t('notesAiPolish'), 'polish'),
    mkAct(t('notesAiTranslate'), 'translate'), mkAct(t('notesAiSummary'), 'summary'),
    mkAct(t('notesAiTodo'), 'todo'),
  );
  const customRow = el('div', 'gg-ai-custom');
  const customInput = el('input') as HTMLInputElement;
  customInput.placeholder = t('notesAiCustom');
  customInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') void aiRun('custom', customInput.value);
  });
  const go = el('button', 'gg-ai-go', '→') as HTMLButtonElement;
  go.addEventListener('click', () => void aiRun('custom', customInput.value));
  customRow.append(customInput, go);
  aiResultBox = el('div', 'gg-ai-result hidden');
  aiNewBox = el('div', 'gg-ai-new');
  const ops = el('div', 'gg-ai-ops');
  const mkOp = (label: string, fn: () => void): HTMLElement => {
    const b = el('button', 'gg-ai-op', label) as HTMLButtonElement;
    b.addEventListener('click', fn);
    return b;
  };
  ops.append(
    mkOp('✓ ' + t('notesAiAccept'), () => aiAccept(true)),
    mkOp('＋ ' + t('notesAiInsert'), () => aiAccept(false)),
    mkOp('✕ ' + t('notesAiDiscard'), aiClose),
  );
  aiResultBox.append(el('div', 'gg-ai-old', ''), aiNewBox, ops);
  aiPop.append(aiHead, acts, customRow, aiResultBox);
  editorHost.appendChild(aiPop);

  const slashGroups = buildSlashItems(t);
  slashGroups.find(g2 => g2.label === t('notesGroupMedia'))?.items.push({
    icon: '🖼', title: t('notesInsertImage'), desc: 'data URL 内嵌',
    keywords: `${t('notesInsertImage')} image 图片 插图 photo`.toLowerCase(),
    run: () => { void insertImageFlow(); },
  });
  slash = createSlashMenu(editorHost, slashGroups, (item: SlashItem) => {
    item.run(ed);
    markDirty();
    ed.view.focus();
  });

  // v0.17 反馈 #5："/" 菜单与 AI 浮层 —— 点击空白或 ESC 一律关闭
  document.addEventListener('pointerdown', e => {
    const target = e.target as Node;
    if (slash?.visible && !slash.el.contains(target)) slash.close();
    if (!aiPop.classList.contains('hidden') && !aiPop.contains(target)) aiClose();
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    let used = false;
    if (slash?.visible) { slash.close(); used = true; }
    if (!aiPop.classList.contains('hidden')) { aiClose(); used = true; }
    if (used) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  buildToolbar();
}

// ---------- 消息处理 ----------
window.addEventListener('message', e => {
  const m = e.data as NotesEvent | NotesResponse;
  if (!m || typeof m !== 'object') return;
  if ((m as NotesResponse).t === 'res') { handleResponse(m as any); return; }
  const ev = m as NotesEvent;
  switch (ev.t) {
    case 'notesReady': {
      dir = ev.dir;
      notes = ev.notes;
      t = createT((ev.language === 'en' ? 'en' : 'zh-CN') as Lang);
      (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT = t;
      fontZh = ev.fontZh ?? '微软雅黑';
      fontEn = ev.fontEn ?? 'Segoe UI';
      applyFonts();
      buildShell();
      docTitle.placeholder = t('notesUntitledDefault');
      fileList.setDir(dir);
      fileList.setNotes(notes);
      ed = createNotesEditor(doc, {
        menuHost: calloutMenuHost,
        placeholder: t('notesUntitled'),
        onUpdate: () => { checkSlashTrigger(); markDirty(); refreshOutline(); },
        onSelectionUpdate: () => {
          outline.setActive(currentHeadingPos(ed));
          syncCodeLangMenu();
        },
      });
      applyBg();
      refreshOutline();
      // 行号随文档结构变化重算（含开关恢复）
      ed.on('transaction', () => requestAnimationFrame(renumber));
      // v0.18 反馈 #1：图片异步加载/字体晚到等导致块高变化后行号跟随（transaction 不会触发）
      const lnRo = new ResizeObserver(() => { if (showLnOn) renumber(); });
      lnRo.observe(ed.view.dom);
      try { if (localStorage.getItem('gbNotes.ln') === '1') toggleLn(true); } catch { /* ignore */ }
      window.addEventListener('resize', () => { if (showLnOn) renumber(); });
      // 暴露编辑器实例（harness/CDP 测试驱动用）
      (window as unknown as { __gbEd?: Editor }).__gbEd = ed;
      break;
    }
    case 'notesList':
      notes = ev.notes;
      fileList.setNotes(notes);
      if (activeId) fileList.setActive(activeId);
      break;
    case 'dirChanged':
      dir = ev.dir;
      fileList.setDir(dir);
      break;
    case 'saved':
      if (ev.id === activeId && !dirty) { setSaveState('saved', ev.at); setDocMeta(ev.at); }
      break;
    case 'openNote':
      void openNote(ev.id);
      break;
    case 'importNote':
      void (async () => {
        await flushSave();
        activeId = undefined;
        const split = splitTitleDoc(ev.doc);
        activeTitle = ev.title || split.title || t('notesUntitledDefault');
        docTitle.value = ev.title || split.title;
        setDocMeta();
        ed.commands.setContent(split.doc as any);
        dirty = false;
        fileList.setActive(undefined);
        refreshTitlebar();
        refreshOutline();
        toast('info', t('notesReopenEditable'));
      })();
      break;
    case 'notify':
      toast(ev.level, ev.message);
      break;
    case 'aiChunk':
      aiText += ev.text;
      aiNewBox.textContent = aiText;
      break;
    case 'aiDone':
      aiText = ev.text;
      aiNewBox.textContent = aiText;
      break;
    case 'aiError':
      aiBusy = false;
      toast('error', ev.message);
      break;
  }
});

/** 光标进出代码块时，更新代码块按钮 title 中的当前语言提示（轻量联动） */
function syncCodeLangMenu(): void {
  const lang = currentCodeLang(ed);
  const btn = [...toolbar.querySelectorAll<HTMLElement>('.gg-tbtn')].find(b => b.textContent?.startsWith('</>'));
  if (btn) btn.title = lang
    ? `代码块（当前语言：${lang}——下拉可切换）`
    : '代码块（选择语言插入；光标在代码块内=切换语言）';
}

postRaw({ t: 'bootstrap' });
window.addEventListener('beforeunload', () => { if (dirty) void save(); });
