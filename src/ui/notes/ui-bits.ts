/**
 * 笔记面板 UI 素材（v0.16）：emoji 分类清单、颜色板、代码语言清单、系统字体探测。
 * 纯数据与 DOM 工厂，无编辑器依赖。
 */
import { el, clearChildren } from '../util';

// ---------- Emoji（常用 200+，四分类） ----------

export const EMOJI_GROUPS: { label: string; items: string[] }[] = [
  {
    label: '表情与手势',
    items: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','😵','🤯','🤠','🥳','😎','🤓','🧐','😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','🤬','💀','💩','🤡','👋','🤚','✋','🖖','👌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪'],
  },
  {
    label: '状态与符号',
    items: ['✅','❌','⭕','🚫','⚠️','❗','❓','💡','🔒','🔓','📌','📎','🔗','➕','➖','✖️','➗','♾️','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🔶','🔷','🔸','🔹','⭐','🌟','✨','⚡','🔥','💥','❄️','🌈','☀️','🌙','☔'],
  },
  {
    label: '工作与对象',
    items: ['💻','🖥️','⌨️','🖱️','🖨️','📱','☎️','📧','📨','✉️','📮','📝','📋','📄','📑','📊','📈','📉','🗒️','🗓️','📅','⏰','⏳','🕐','💼','🏢','🚀','🎯','🧩','🔧','🔨','⚙️','🧮','✂️','🖊️','✏️','🖌️','🔍','🔎','💾','📀','💿','📷','🎥','🎬'],
  },
  {
    label: '生活与自然',
    items: ['🍎','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍒','🍑','🥭','🍍','🥝','🍅','🥑','🌽','🥕','🍞','🧀','🍗','🍖','🍳','🍔','🍟','🍕','🌮','🍜','🍣','🍩','🍪','🎂','🍰','☕','🍵','🧋','🥤','🍺','🍻','🥂','🍷','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦆','🦉','🦋','🐢','🐟','🐬','🐳','🌸','🌹','🌻','🌴','🌵','🍀','🌍','⛰️','🏔️','🌊','🚗','✈️','🚄','🚲','🏠','🏥','🎓','🎉','🎊','🎁','🏆','🥇','⚽','🏀','🎮','🎲','🎵','🎶','📚','📖'],
  },
];

// ---------- 颜色板 ----------

export const TEXT_COLOR_LIST = ['#1f2328', '#6a737d', '#cf222e', '#d4a72c', '#1a7f37', '#0969da', '#8250df', '#bf3989', '#e16f24', '#0f7b8a'];
export const HIGHLIGHT_LIST = ['#fff3a3', '#c3f9c9', '#b8e0ff', '#ffd6e8', '#e4ccff', '#ffd9b3', '#d3f3ee'];

/** 颜色选择网格；onPick('') = 清除。onClose 由宿主注入用于选后收起浮层。 */
export function buildColorGrid(colors: string[], current: string, withClear: boolean, onPick: (c: string) => void, onClose: () => void): HTMLElement {
  const grid = el('div', 'gg-color-grid');
  const pick = (color: string): void => { onPick(color); onClose(); };
  const mk = (color: string, title: string): void => {
    const c = el('button', 'gg-color-cell' + (current === color ? ' on' : '')) as HTMLButtonElement;
    if (color) c.style.background = color;
    else { c.classList.add('none'); c.textContent = '∅'; }
    c.title = title;
    c.addEventListener('click', () => pick(color));
    grid.appendChild(c);
  };
  if (withClear) mk('', '默认颜色');
  for (const c of colors) mk(c, c);
  const customLabel = el('button', 'gg-color-cell custom', '⁺') as HTMLButtonElement;
  customLabel.title = '自定义颜色';
  const input = el('input') as HTMLInputElement;
  input.type = 'color';
  input.style.display = 'none';
  customLabel.addEventListener('click', () => input.click());
  input.addEventListener('input', () => pick(input.value));
  grid.append(customLabel, input);
  return grid;
}

/** emoji 面板（分类 tab + 网格） */
export function buildEmojiPanel(onPick: (ch: string) => void, onClose: () => void): HTMLElement {
  const root = el('div', 'gg-emoji-panel');
  const tabs = el('div', 'gg-emoji-tabs');
  const body = el('div', 'gg-emoji-body');
  const pick = (ch: string): void => { onPick(ch); onClose(); };
  EMOJI_GROUPS.forEach((g, i) => {
    const tab = el('button', 'gg-emoji-tab' + (i === 0 ? ' on' : '')) as HTMLButtonElement;
    tab.textContent = g.label.split('与')[0].slice(0, 2);
    tab.title = g.label;
    tab.addEventListener('click', () => {
      for (const t of tabs.children) t.classList.remove('on');
      tab.classList.add('on');
      renderGroup(g.items);
    });
    tabs.appendChild(tab);
  });
  function renderGroup(items: string[]): void {
    clearChildren(body);
    for (const ch of items) {
      const b = el('button', 'gg-emoji-cell') as HTMLButtonElement;
      b.textContent = ch;
      b.title = ch;
      b.addEventListener('click', () => pick(ch));
      body.appendChild(b);
    }
  }
  root.append(tabs, body);
  renderGroup(EMOJI_GROUPS[0].items);
  return root;
}

// ---------- 代码语言 ----------

export const CODE_LANGS = [
  ['plaintext', '纯文本'], ['javascript', 'JavaScript'], ['typescript', 'TypeScript'],
  ['python', 'Python'], ['java', 'Java'], ['c', 'C'], ['cpp', 'C++'], ['csharp', 'C#'],
  ['go', 'Go'], ['rust', 'Rust'], ['php', 'PHP'], ['ruby', 'Ruby'], ['swift', 'Swift'],
  ['kotlin', 'Kotlin'], ['sql', 'SQL'], ['bash', 'Shell'], ['json', 'JSON'],
  ['yaml', 'YAML'], ['xml', 'XML/HTML'], ['css', 'CSS'], ['markdown', 'Markdown'],
  ['dockerfile', 'Dockerfile'],
] as const;

// ---------- 系统字体 ----------

/** 内置常见字体清单（queryLocalFonts 不可用时的回退） */
const FALLBACK_FONTS: Record<string, string[]> = {
  win32: ['微软雅黑', '宋体', '黑体', '楷体', '仿宋', '等线', 'Segoe UI', 'Calibri', 'Arial', 'Tahoma', 'Verdana', 'Times New Roman', 'Consolas', 'Courier New', 'Georgia'],
  darwin: ['PingFang SC', '华文黑体', 'Heiti SC', '宋体-简', 'Helvetica Neue', 'Arial', 'Menlo', 'Monaco', 'Courier New', 'Georgia'],
  linux: ['Noto Sans CJK SC', 'WenQuanYi Micro Hei', 'Ubuntu', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans', 'Noto Mono'],
};

/** 枚举系统字体：优先 Local Font Access API（Chrome 103+），失败回退内置清单 */
export async function listSystemFonts(): Promise<{ all: string[]; viaApi: boolean }> {
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
    if (typeof q === 'function') {
      const list = await q.call(window);
      const fams = [...new Set(list.map(f => f.family))].sort((a, b) => a.localeCompare(b));
      if (fams.length) return { all: fams, viaApi: true };
    }
  } catch { /* 无权限或不可用：回退清单 */ }
  const p = navigator.platform.toLowerCase();
  const key = p.startsWith('mac') ? 'darwin' : p.includes('linux') ? 'linux' : 'win32';
  return { all: FALLBACK_FONTS[key] ?? FALLBACK_FONTS.win32, viaApi: false };
}
