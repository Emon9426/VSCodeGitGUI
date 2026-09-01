/**
 * 「/」命令菜单（v0.15.0）：行首输入 / 或工具栏按钮呼出；中英文关键字过滤；
 * ↑↓ 选择、Enter 确认、Esc 关闭。命令集合 = 编辑器命令封装（setup.ts）。
 */
import type { Editor } from '@tiptap/core';
import { el, clearChildren } from '../util';

export interface SlashItem {
  icon: string;
  title: string;
  desc: string;
  keywords: string;      // 过滤用（含中文与英文别名）
  run(ed: Editor): void;
}

interface Group { label: string; items: SlashItem[] }

export function buildSlashItems(t: (k: string) => string): Group[] {
  const mk = (icon: string, title: string, desc: string, kw: string, run: (ed: Editor) => void): SlashItem =>
    ({ icon, title, desc, keywords: `${title} ${desc} ${kw}`.toLowerCase(), run });
  return [
    {
      label: t('notesGroupStruct'),
      items: [
        mk('H₁', '标题 1', '一级章节', 'heading h1 标题', ed => { ed.chain().focus().toggleHeading({ level: 1 }).run(); }),
        mk('H₂', '标题 2', '二级章节', 'heading h2 标题', ed => { ed.chain().focus().toggleHeading({ level: 2 }).run(); }),
        mk('H₃', '标题 3', '三级章节', 'heading h3 标题', ed => { ed.chain().focus().toggleHeading({ level: 3 }).run(); }),
        mk('H₄', '标题 4', '四级小节', 'heading h4 标题', ed => { ed.chain().focus().toggleHeading({ level: 4 }).run(); }),
      ],
    },
    {
      label: t('notesGroupList'),
      items: [
        mk('•—', '无序列表', '圆点列表', 'bullet list 无序', ed => { ed.chain().focus().toggleBulletList().run(); }),
        mk('1.', '有序列表', '编号列表', 'ordered list 有序 number', ed => { ed.chain().focus().toggleOrderedList().run(); }),
        mk('☑', '待办列表', '可勾选任务', 'todo task check 待办', ed => { ed.chain().focus().toggleTaskList().run(); }),
      ],
    },
    {
      label: t('notesGroupContent'),
      items: [
        mk('▦', '表格', '3×3 · 支持合并/嵌套', 'table 表格', ed => { ed.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); }),
        mk('</>', '代码块', '语言高亮 + 复制', 'code block 代码', ed => { ed.chain().focus().toggleCodeBlock().run(); }),
        mk('⌗', '行内代码', '正文中的代码', 'inline code 行内', ed => { ed.chain().focus().toggleCode().run(); }),
        mk('❝', '引用块', '摘录与出处', 'quote blockquote 引用', ed => { ed.chain().focus().toggleBlockquote().run(); }),
        mk('—', '分割线', '水平分隔', 'divider hr rule 分割线', ed => { ed.chain().focus().setHorizontalRule().run(); }),
        mk('🕗', '时间戳', '当前日期时间', 'timestamp date time 时间', ed => {
          const d = new Date();
          const p = (n: number): string => String(n).padStart(2, '0');
          void ed.chain().focus().insertContent(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`).run();
        }),
        mk('ℹ️', '信息卡片', '蓝色提示容器', 'info card callout 信息 卡片', ed => { ed.chain().focus().insertCallout('info').run(); }),
        mk('✅', '成功卡片', '绿色结果容器', 'ok success card callout 成功 卡片', ed => { ed.chain().focus().insertCallout('ok').run(); }),
        mk('⚠️', '警告卡片', '黄色注意容器', 'warn warning card callout 警告 卡片', ed => { ed.chain().focus().insertCallout('warn').run(); }),
        mk('⛔', '危险卡片', '红色警示容器', 'danger error card callout 危险 卡片', ed => { ed.chain().focus().insertCallout('danger').run(); }),
        mk('📝', '笔记卡片', '中性备忘容器', 'note card callout 笔记 卡片', ed => { ed.chain().focus().insertCallout('note').run(); }),
      ],
    },
    {
      label: t('notesGroupMedia'),
      items: [
        mk('🎨', '画板', '基础图形 + 箭头连线', 'sketch draw diagram flow 画板 画图 流程图', ed => { ed.chain().focus().insertSketch().run(); }),
      ],
    },
  ];
}

export interface SlashMenu {
  el: HTMLElement;
  open(x: number, y: number): void;
  close(): void;
  get visible(): boolean;
  filter(q: string): void;
  move(dir: 1 | -1): void;
  pickCurrent(): void;
}

export function createSlashMenu(host: HTMLElement, groups: Group[], onPick: (item: SlashItem) => void): SlashMenu {
  const box = el('div', 'gg-slash hidden');
  const input = el('input', 'gg-slash-input') as HTMLInputElement;
  input.placeholder = '';
  const list = el('div', 'gg-slash-list');
  box.append(input, list);
  host.appendChild(box);
  let flat: { item: SlashItem; el2: HTMLElement }[] = [];
  let cur = 0;
  const items = groups;

  const refilter = (q: string): void => {
    const s = q.trim().toLowerCase();
    clearChildren(list);
    flat = [];
    for (const g of items) {
      const hit = g.items.filter(it => !s || it.keywords.includes(s));
      if (!hit.length) continue;
      list.appendChild(el('div', 'gg-slash-group', g.label));
      for (const it of hit) {
        const row = el('div', 'gg-slash-item');
        const ico = el('span', 'gg-slash-ico', it.icon);
        const txt = el('div');
        txt.append(el('div', 'gg-slash-tt', it.title), el('div', 'gg-slash-dd', it.desc));
        row.append(ico, txt);
        row.addEventListener('click', () => { onPick(it); close(); });
        list.appendChild(row);
        flat.push({ item: it, el2: row });
      }
    }
    cur = 0;
    highlight();
  };

  const highlight = (): void => {
    flat.forEach((f, i) => f.el2.classList.toggle('cur', i === cur));
    flat[cur]?.el2.scrollIntoView({ block: 'nearest' });
  };

  input.addEventListener('input', () => refilter(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); pickCurrent(); }
    else if (e.key === 'Escape') { close(); }
    e.stopPropagation();
  });

  function open(x: number, y: number): void {
    box.classList.remove('hidden');
    box.style.left = `${Math.max(8, Math.min(x, host.clientWidth - 310))}px`;
    box.style.top = `${Math.min(y + 8, host.clientHeight - 340)}px`;
    input.value = '';
    refilter('');
    setTimeout(() => input.focus(), 0);
  }
  function close(): void {
    box.classList.add('hidden');
  }
  function move(dir: 1 | -1): void {
    if (!flat.length) return;
    cur = Math.max(0, Math.min(flat.length - 1, cur + dir));
    highlight();
  }
  function pickCurrent(): void {
    const f = flat[cur];
    if (f) { onPick(f.item); close(); }
  }

  return {
    el: box,
    open,
    close,
    get visible() { return !box.classList.contains('hidden'); },
    filter: (q: string) => { input.value = q; refilter(q); },
    move,
    pickCurrent,
  };
}
