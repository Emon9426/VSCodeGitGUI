/**
 * 分支选择器（Issue #24）：搜索 + 子序列模糊匹配高亮的模态列表。
 * - filter 模式：头部含三个范围项（全部/本地/当前分支），其余为 ref 精选（与侧栏单击过滤同语义，可再点取消）
 * - checkout 模式：本地分支直接检出；远程分支底部内联输入本地名（预填剥离 remote 前缀的建议名）回车检出；
 *   底部恒有「新建分支」行（checkout -b，基于当前 HEAD），无匹配时成为唯一可选项（搜索词即新分支名）
 * 键盘：↑↓ 移动高亮、Enter 确认、Esc 关闭；无查询按分组呈现，查询时按匹配分排序平铺。
 */
import type { BranchInfo, GraphScope } from '../../common/models';
import { S, type App } from '../state';
import { el } from '../util';
import { fuzzyMatch } from '../fuzzy';
import { buildPrefixTree, countNode, stripTo, type PrefixNode } from './branchGroup';
import { openModal } from './overlays';

type Row =
  | { kind: 'scope'; mode: GraphScope; label: string; active: boolean }
  | { kind: 'local'; b: BranchInfo; active: boolean }
  | { kind: 'remote'; b: BranchInfo; remote: string; hasLocal: boolean }
  | { kind: 'create' };   // 新建分支（checkout -b），仅 checkout 模式渲染

interface Entry {
  row: Row;
  /** 参与匹配的文本（远程行用全名，剥离前缀与全名都可命中） */
  text: string;
  score: number;
  positions: number[];
  /** 缩进层级（#22 A1；v0.23.2 递归多级）：0=区内顶层行 28px，每深一级 +16px；查询态平铺不设（12px） */
  depth?: number;
  /** 分组态显示名（v0.23.2 剥组前缀短名）；查询态不设、用 display 名 */
  disp?: string;
}

export function openBranchPicker(app: App, mode: 'filter' | 'checkout'): void {
  const st = S.state;
  if (!st) return;
  const { box, body, close } = openModal(mode === 'checkout' ? S.t('checkoutPickerTitle') : S.t('filterPickerTitle'));
  box.classList.add('gg-bp');

  const search = el('input', 'gg-input gg-bp-search') as HTMLInputElement;
  search.placeholder = S.t('searchBranchPh');
  const list = el('div', 'gg-bp-list');
  // 远程内联检出输入区（点选远程分支时出现）
  const inline = el('div', 'gg-bp-inline hidden');
  const inlineLabel = el('span', 'gg-bp-inline-label', S.t('checkoutNameLabel'));
  const inlineInput = el('input', 'gg-input') as HTMLInputElement;
  const inlineGo = el('button', 'gg-btn primary', S.t('checkoutAsGo')) as HTMLButtonElement;
  inline.append(inlineLabel, inlineInput, inlineGo);
  const hint = el('div', 'gg-bp-hint', mode === 'checkout' ? S.t('pickerCheckoutHint') : S.t('pickerFilterHint'));
  body.append(search, list, inline, hint);
  box.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  const localNames = new Set(st.branches.map(b => b.name));
  const strip = (n: string) => (n.includes('/') ? n.slice(n.indexOf('/') + 1) : n);

  /** 全量条目（显示名/匹配名分离：远程行显示剥前缀名，匹配用全名） */
  const all: { row: Row; display: string; sub: string }[] = [];
  if (mode === 'filter') {
    const scope: GraphScope = st.scopeMode ?? S.config.graphBranchScope;
    for (const m of ['all', 'local', 'current'] as const) {
      const label = S.t(`scope${m[0].toUpperCase()}${m.slice(1)}`);
      all.push({ row: { kind: 'scope', mode: m, label, active: !st.filterRef && scope === m }, display: label, sub: '' });
    }
  }
  for (const b of st.branches) all.push({ row: { kind: 'local', b, active: st.filterRef === b.fullName }, display: b.name, sub: '' });
  for (const g of st.remotes) {
    for (const b of g.branches) {
      const stripped = strip(b.name);
      all.push({ row: { kind: 'remote', b, remote: g.name, hasLocal: localNames.has(stripped) }, display: stripped, sub: g.name });
    }
  }

  let entries: Entry[] = [];        // 当前渲染条目（与 DOM 行序一致）
  let active = 0;
  /** 内联输入态（Issue #24 三轮）：track=远程分支起本地名；create=新建分支（基于 HEAD） */
  let inlineMode: { kind: 'track'; src: { row: Row; display: string } } | { kind: 'create' } | null = null;

  /** 分区头（#22 A1；v0.23.2 递归）：level 1=大区（12px），≥2=前缀组头（26px 起每深一级 +16px） */
  function sectionHead(text: string, count?: number, level: number = 1): HTMLElement {
    const h = el('div', `gg-bp-head${level > 1 ? ' l2' : ''}`, text);
    if (level > 1) h.style.setProperty('--k', String(level - 2));
    if (count !== undefined) h.appendChild(el('span', 'gg-bp-count', String(count)));
    return h;
  }

  /** 行节点：命中下标高亮 <b>；点击即确认 */
  function rowEl(e: Entry): HTMLElement {
    const r = e.row;
    const row = el('div', `gg-bp-row${e.depth !== undefined ? ' d' : ''}${r.kind === 'scope' ? ' scope' : ''}`);
    if (e.depth !== undefined) row.style.setProperty('--d', String(e.depth));
    if (r.kind === 'scope') row.appendChild(el('span', 'gg-bp-ic', '◎'));
    else if (r.kind === 'local') row.appendChild(el('span', 'gg-bp-ic', r.b.isHead ? '●' : '⑂'));
    else row.appendChild(el('span', 'gg-bp-ic', '⇅'));
    const nm = el('span', 'gg-bp-name');
    const name = e.disp ?? displayNameOf(e);
    let last = 0;
    for (const p of e.positions) {
      if (p < last || p >= name.length) continue;
      if (p > last) nm.appendChild(document.createTextNode(name.slice(last, p)));
      nm.appendChild(el('b', undefined, name[p]));
      last = p + 1;
    }
    nm.appendChild(document.createTextNode(name.slice(last)));
    row.appendChild(nm);
    if (r.kind === 'local' && r.active) row.appendChild(el('span', 'gg-bp-flag', '✓'));
    if (r.kind === 'remote') {
      if (r.hasLocal) row.appendChild(el('span', 'gg-side-flag', S.t('branchHasLocal')));
      row.appendChild(el('span', 'gg-bp-sub', r.remote));
    }
    row.addEventListener('click', () => { active = entries.indexOf(e); paintActive(); pick(e); });
    return row;
  }

  /** 高亮下标基于 display 名，而 e.text（远程=全名）用于匹配——把 positions 映射回 display 名 */
  function displayNameOf(e: Entry): string {
    const src = all.find(a => a.row === e.row);
    return src ? src.display : '';
  }

  function render(): void {
    list.textContent = '';
    const q = search.value.trim();
    const ordered: Entry[] = [];
    const addRow = (a: { row: Row; display: string; sub: string }, positions: number[] = [], depth?: number, disp?: string) => {
      const e: Entry = { row: a.row, text: '', score: 0, positions, depth, disp };
      ordered.push(e);
      list.appendChild(rowEl(e));
    };
    /** 前缀组树递归（v0.23.2）：以 depth=0 调用 → 一级组头 level 2（26px）、组内行 depth 1（44px），每深一级 +16px */
    const renderTree = (node: PrefixNode<{ row: Row; display: string; sub: string }>, depth: number): void => {
      for (const a of node.items) addRow(a, [], depth, stripTo(node.path, a.display));
      for (const ch of node.children) {
        list.appendChild(sectionHead(`${ch.seg}/`, countNode(ch), depth + 2));
        renderTree(ch, depth + 1);
      }
    };

    if (q) {
      const hits: { a: { row: Row; display: string; sub: string }; score: number; positions: number[]; text: string }[] = [];
      for (const a of all) {
        const matchText = a.row.kind === 'remote' ? a.row.b.name : a.display;
        const hit = fuzzyMatch(q, matchText);
        if (hit) hits.push({ a, score: hit.score, positions: hit.positions, text: matchText });
      }
      hits.sort((x, y) => y.score - x.score);
      if (hits.length) {
        for (const h of hits) {
          // 远程行 positions 基于全名，display 是剥前缀名——偏移映射（全名 = remote + '/' + display）
          const off = h.a.row.kind === 'remote' ? h.a.row.b.name.length - h.a.display.length : 0;
          const positions = off ? h.positions.map(p => p - off).filter(p => p >= 0) : h.positions;
          addRow(h.a, positions);
        }
      } else {
        list.appendChild(el('div', 'gg-bp-empty', S.t('pickerNoMatch')));
      }
    } else {
      // 无查询：分组呈现（范围项 → 当前 → 本地（前缀分组）→ 各远程（剥前缀再分组））
      if (mode === 'filter') {
        const scopes = all.filter(a => a.row.kind === 'scope');
        if (scopes.length) {
          list.appendChild(sectionHead(S.t('pickerScope')));
          for (const a of scopes) addRow(a, [], 0);
        }
      }
      const locals = all.filter(a => a.row.kind === 'local');
      const remotes = all.filter(a => a.row.kind === 'remote');
      const headName = st?.head.branch;
      const headEntry = locals.find(a => (a.row as { b: BranchInfo }).b.name === headName);
      if (headEntry) {
        list.appendChild(sectionHead(S.t('pickerCurrent')));
        addRow(headEntry, [], 0);
      }
      const others = locals.filter(a => (a.row as { b: BranchInfo }).b.name !== headName);
      list.appendChild(sectionHead(S.t('pickerLocals'), others.length));
      const lg = buildPrefixTree(others, a => a.display);
      for (const a of lg.top) addRow(a, [], 0);
      renderTree(lg.root, 0);
      if (remotes.length) {
        const byOrigin = new Map<string, { row: Row; display: string; sub: string }[]>();
        for (const a of remotes) {
          const arr = byOrigin.get((a.row as { remote: string }).remote) ?? [];
          arr.push(a);
          byOrigin.set((a.row as { remote: string }).remote, arr);
        }
        for (const [origin, arr] of byOrigin) {
          list.appendChild(sectionHead(`${S.t('pickerRemotes')} · ${origin}`, arr.length));
          const rg = buildPrefixTree(arr, a => a.display);
          for (const a of rg.top) addRow(a, [], 0);
          renderTree(rg.root, 0);
        }
      }
    }
    // 检出模式：底部恒有「新建分支」行（无匹配时成为唯一可选项，Enter 直达新建；搜索词即预填名）
    if (mode === 'checkout') {
      const e: Entry = { row: { kind: 'create' }, text: '', score: 0, positions: [], depth: 0 };
      ordered.push(e);
      list.appendChild(createRowEl(e, q));
    }
    entries = ordered;
    if (active >= entries.length) active = Math.max(0, entries.length - 1);
    paintActive();
  }

  /** 「＋ 新建分支 “<q>”」特殊行：基于当前 HEAD 的 checkout -b */
  function createRowEl(e: Entry, q: string): HTMLElement {
    const row = el('div', 'gg-bp-row create');
    row.appendChild(el('span', 'gg-bp-ic', '＋'));
    const nm = el('span', 'gg-bp-name');
    nm.appendChild(document.createTextNode(S.t('pickerCreateBranch') + (q ? ' ' : '')));
    if (q) nm.appendChild(el('b', undefined, q));
    row.appendChild(nm);
    row.appendChild(el('span', 'gg-bp-sub', 'HEAD'));
    row.title = S.t('pickerCreateHint');
    row.addEventListener('click', () => { active = entries.indexOf(e); paintActive(); pick(e); });
    return row;
  }

  function paintActive(): void {
    const rows = [...list.querySelectorAll('.gg-bp-row')] as HTMLElement[];
    rows.forEach((r, i) => r.classList.toggle('active', i === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  }

  /** 确认条目：scope → setScope；local → 过滤/检出；remote → 过滤 / 内联输入本地名；create → 内联输入新名 */
  function pick(e: Entry): void {
    const r = e.row;
    if (r.kind === 'create') {
      // 新建分支（checkout -b @ HEAD）：搜索词预填——搜索即命名
      inlineMode = { kind: 'create' };
      inlineLabel.textContent = S.t('pickerCreateBranch');
      inlineGo.textContent = S.t('createBranchGo');
      hint.textContent = S.t('pickerCreateHint');
      inline.classList.remove('hidden');
      inlineInput.value = search.value.trim();
      inlineInput.focus();
      inlineInput.select();
      return;
    }
    const src = all.find(a => a.row === r);
    if (!src) return;
    if (r.kind === 'scope') {
      app.setScope(r.mode);
      close();
    } else if (r.kind === 'local') {
      if (mode === 'checkout') app.checkoutRef(r.b.name);
      else app.setFilter(S.state?.filterRef === r.b.fullName ? null : r.b.fullName);
      close();
    } else if (mode === 'checkout') {
      // 远程分支：底部内联输入本地名（一步直达，不叠弹窗）
      inlineMode = { kind: 'track', src };
      inlineLabel.textContent = S.t('checkoutNameLabel');
      inlineGo.textContent = S.t('checkoutAsGo');
      hint.textContent = S.t('pickerCheckoutHint');
      inline.classList.remove('hidden');
      inlineInput.value = src.display;
      inlineInput.focus();
      inlineInput.select();
    } else {
      app.setFilter(S.state?.filterRef === r.b.fullName ? null : r.b.fullName);
      close();
    }
  }

  function resetInline(): void {
    inlineMode = null;
    inline.classList.add('hidden');
    hint.textContent = mode === 'checkout' ? S.t('pickerCheckoutHint') : S.t('pickerFilterHint');
  }

  search.addEventListener('input', () => { active = 0; resetInline(); render(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = entries.length;
      if (!n) return;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (entries[active]) pick(entries[active]);
    }
  });
  inlineInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      goInline();
    } else if (e.key === 'Escape') {
      resetInline();
      search.focus();
    }
  });
  inlineGo.addEventListener('click', goInline);

  function goInline(): void {
    const name = inlineInput.value.trim();
    if (!name) return;
    if (inlineMode?.kind === 'track' && inlineMode.src.row.kind === 'remote') {
      app.checkoutTrack(name, inlineMode.src.row.b.name);
      close();
    } else if (inlineMode?.kind === 'create') {
      app.checkoutCreate(name);
      close();
    }
  }

  render();
  search.focus();
}
