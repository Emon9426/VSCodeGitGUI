/**
 * 分支选择器（Issue #24）：搜索 + 子序列模糊匹配高亮的模态列表。
 * - filter 模式：头部含三个范围项（全部/本地/当前分支），其余为 ref 精选（与侧栏单击过滤同语义，可再点取消）
 * - checkout 模式：本地分支直接检出；远程分支底部内联输入本地名（预填剥离 remote 前缀的建议名）回车检出
 * 键盘：↑↓ 移动高亮、Enter 确认、Esc 关闭；无查询按分组呈现，查询时按匹配分排序平铺。
 */
import type { BranchInfo, GraphScope } from '../../common/models';
import { S, type App } from '../state';
import { el } from '../util';
import { fuzzyMatch } from '../fuzzy';
import { groupByPrefix } from './branchGroup';
import { openModal } from './overlays';

type Row =
  | { kind: 'scope'; mode: GraphScope; label: string; active: boolean }
  | { kind: 'local'; b: BranchInfo; active: boolean }
  | { kind: 'remote'; b: BranchInfo; remote: string; hasLocal: boolean };

interface Entry {
  row: Row;
  /** 参与匹配的文本（远程行用全名，剥离前缀与全名都可命中） */
  text: string;
  score: number;
  positions: number[];
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
  let pickedRemote: { row: Row; display: string } | null = null;   // 内联输入针对的远程分支

  function sectionHead(text: string, count?: number): HTMLElement {
    const h = el('div', 'gg-bp-head', text);
    if (count !== undefined) h.appendChild(el('span', 'gg-bp-count', String(count)));
    return h;
  }

  /** 行节点：命中下标高亮 <b>；点击即确认 */
  function rowEl(e: Entry): HTMLElement {
    const r = e.row;
    const row = el('div', `gg-bp-row${r.kind === 'scope' ? ' scope' : ''}`);
    if (r.kind === 'scope') row.appendChild(el('span', 'gg-bp-ic', '◎'));
    else if (r.kind === 'local') row.appendChild(el('span', 'gg-bp-ic', r.b.isHead ? '●' : '⑂'));
    else row.appendChild(el('span', 'gg-bp-ic', '⇅'));
    const nm = el('span', 'gg-bp-name');
    const name = displayNameOf(e);
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
    const addRow = (a: { row: Row; display: string; sub: string }, positions: number[] = []) => {
      const e: Entry = { row: a.row, text: '', score: 0, positions };
      ordered.push(e);
      list.appendChild(rowEl(e));
    };

    if (q) {
      const hits: { a: { row: Row; display: string; sub: string }; score: number; positions: number[]; text: string }[] = [];
      for (const a of all) {
        const matchText = a.row.kind === 'remote' ? a.row.b.name : a.display;
        const hit = fuzzyMatch(q, matchText);
        if (hit) hits.push({ a, score: hit.score, positions: hit.positions, text: matchText });
      }
      hits.sort((x, y) => y.score - x.score);
      if (!hits.length) {
        list.appendChild(el('div', 'gg-bp-empty', S.t('pickerNoMatch')));
        entries = [];
        return;
      }
      for (const h of hits) {
        // 远程行 positions 基于全名，display 是剥前缀名——偏移映射（全名 = remote + '/' + display）
        const off = h.a.row.kind === 'remote' ? h.a.row.b.name.length - h.a.display.length : 0;
        const positions = off ? h.positions.map(p => p - off).filter(p => p >= 0) : h.positions;
        addRow(h.a, positions);
      }
      entries = ordered;
      return;
    }

    // 无查询：分组呈现（范围项 → 当前 → 本地（前缀分组）→ 各远程（剥前缀再分组））
    if (mode === 'filter') {
      const scopes = all.filter(a => a.row.kind === 'scope');
      if (scopes.length) {
        list.appendChild(sectionHead(S.t('pickerScope')));
        for (const a of scopes) addRow(a);
      }
    }
    const locals = all.filter(a => a.row.kind === 'local');
    const remotes = all.filter(a => a.row.kind === 'remote');
    const headName = st?.head.branch;
    const headEntry = locals.find(a => (a.row as { b: BranchInfo }).b.name === headName);
    if (headEntry) {
      list.appendChild(sectionHead(S.t('pickerCurrent')));
      addRow(headEntry);
    }
    const others = locals.filter(a => (a.row as { b: BranchInfo }).b.name !== headName);
    list.appendChild(sectionHead(S.t('pickerLocals'), others.length));
    const lg = groupByPrefix(others, a => a.display);
    for (const a of lg.top) addRow(a);
    for (const g of lg.groups) {
      list.appendChild(sectionHead(`${g.prefix}/`, g.items.length));
      for (const a of g.items) addRow(a);
    }
    if (remotes.length) {
      const byOrigin = new Map<string, { row: Row; display: string; sub: string }[]>();
      for (const a of remotes) {
        const arr = byOrigin.get((a.row as { remote: string }).remote) ?? [];
        arr.push(a);
        byOrigin.set((a.row as { remote: string }).remote, arr);
      }
      for (const [origin, arr] of byOrigin) {
        list.appendChild(sectionHead(`${S.t('pickerRemotes')} · ${origin}`, arr.length));
        const rg = groupByPrefix(arr, a => a.display);
        for (const a of rg.top) addRow(a);
        for (const g of rg.groups) {
          list.appendChild(sectionHead(`${g.prefix}/`, g.items.length));
          for (const a of g.items) addRow(a);
        }
      }
    }
    entries = ordered;
    paintActive();
  }

  function paintActive(): void {
    const rows = [...list.querySelectorAll('.gg-bp-row')] as HTMLElement[];
    rows.forEach((r, i) => r.classList.toggle('active', i === active));
    rows[active]?.scrollIntoView({ block: 'nearest' });
  }

  /** 确认条目：scope → setScope；local → 过滤/检出；remote → 过滤 / 内联输入本地名 */
  function pick(e: Entry): void {
    const src = all.find(a => a.row === e.row);
    if (!src) return;
    const r = e.row;
    if (r.kind === 'scope') {
      app.setScope(r.mode);
      close();
    } else if (r.kind === 'local') {
      if (mode === 'checkout') app.checkoutRef(r.b.name);
      else app.setFilter(S.state?.filterRef === r.b.fullName ? null : r.b.fullName);
      close();
    } else if (mode === 'checkout') {
      // 远程分支：底部内联输入本地名（一步直达，不叠弹窗）
      pickedRemote = src;
      inline.classList.remove('hidden');
      inlineInput.value = src.display;
      inlineInput.focus();
      inlineInput.select();
    } else {
      app.setFilter(S.state?.filterRef === r.b.fullName ? null : r.b.fullName);
      close();
    }
  }

  search.addEventListener('input', () => { active = 0; pickedRemote = null; inline.classList.add('hidden'); render(); });
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
      pickedRemote = null;
      inline.classList.add('hidden');
      search.focus();
    }
  });
  inlineGo.addEventListener('click', goInline);

  function goInline(): void {
    const name = inlineInput.value.trim();
    const src = pickedRemote;
    if (!src || src.row.kind !== 'remote' || !name) return;
    app.checkoutTrack(name, src.row.b.name);
    close();
  }

  render();
  search.focus();
}
