/**
 * SVG 画板（v0.16，drawio 式交互重写）：
 * - 放置：选中图形工具后点击画布即放置默认尺寸（拖拽则自定义大小），完成后自动切回选择工具；
 * - 选择：点击图形单选（Ctrl+点击加选）、空白处拖拽框选；拖拽移动所有选中图形；
 * - 缩放：单选图形显示四角手柄（drawio 式小圆点 + 隐形加大命中区），拖拽调整尺寸；
 * - 连线：箭头/直线工具从图形内按下拖到目标图形，端点吸附锚点并绑定（移动图形时端点跟随）；
 *   v0.18 反馈 #5：连线默认 drawio 式正交折线（按端点所在边水平/垂直出线，H-V-H/V-H-V/L 路由）；
 * - 编辑：双击图形/选中后 Enter/工具栏按钮插入文字；Delete 只删画板内选中图形（不删画板）。
 * 渲染全部使用基础 SVG 元素（矩形/椭圆/路径菱形），无 transform 复合变换，杜绝错位乱纹。
 */
import { Node, mergeAttributes } from '@tiptap/core';
import { el } from '../../util';
import { mkNodeDelBtn } from './blockdel';

export interface SketchShape {
  id: string;
  kind: 'rect' | 'round' | 'diamond' | 'ellipse' | 'text' | 'line' | 'arrow';
  x: number; y: number; w: number; h: number;   // 图形：左上+宽高；线/箭头：起点 xy，终点 = x+w, y+h
  text?: string;
  /** 连线绑定：起点/终点所在图形（渲染时吸附该图形最近锚点） */
  src?: string;
  dst?: string;
}
export interface SketchData { w: number; h: number; shapes: SketchShape[] }

declare module '@tiptap/core' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Commands<ReturnType> {
    sketch: {
      /** 光标处插入 SVG 画板 */
      insertSketch(): ReturnType;
    };
  }
}

type Tool = 'select' | SketchShape['kind'];

const NS = 'http://www.w3.org/2000/svg';
// v0.17 反馈 #8：默认尺寸按正文行高（~21px）比例缩小，与文字协调（drawio 视觉密度）
const DEFAULT_SIZE: Record<SketchShape['kind'], { w: number; h: number }> = {
  rect: { w: 80, h: 34 }, round: { w: 80, h: 34 }, diamond: { w: 90, h: 48 },
  ellipse: { w: 70, h: 38 }, text: { w: 56, h: 20 }, line: { w: 90, h: 0 }, arrow: { w: 90, h: 0 },
};

let uidSeq = 0;
const uid = (): string => 's' + Date.now().toString(36) + '-' + (uidSeq++).toString(36);

function emptyData(): SketchData {
  return { w: 620, h: 150, shapes: [] };
}

function parseData(raw: unknown): SketchData {
  if (typeof raw === 'string') {
    try { return { ...emptyData(), ...(JSON.parse(raw) as Partial<SketchData>) }; } catch { return emptyData(); }
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as SketchData).shapes)) {
    return { ...emptyData(), ...(raw as SketchData) };
  }
  return emptyData();
}

/** 图形四边中点锚点 */
function anchors(s: SketchShape): { x: number; y: number }[] {
  return [
    { x: s.x, y: s.y + s.h / 2 }, { x: s.x + s.w, y: s.y + s.h / 2 },
    { x: s.x + s.w / 2, y: s.y }, { x: s.x + s.w / 2, y: s.y + s.h },
  ];
}
function nearestAnchor(s: SketchShape, px: number, py: number): { x: number; y: number } {
  return anchors(s).reduce((a, b) => (Math.hypot(b.x - px, b.y - py) < Math.hypot(a.x - px, a.y - py) ? b : a));
}
function inRect(r: { x: number; y: number; w: number; h: number }, px: number, py: number): boolean {
  return px >= r.x - 2 && px <= r.x + r.w + 2 && py >= r.y - 2 && py <= r.y + r.h + 2;
}
const inShape = (s: SketchShape, px: number, py: number): boolean => inRect(s, px, py);

type Pt = { x: number; y: number };
/** 出线方向（单位向量，水平/垂直之一非零） */
type Dir = { dx: number; dy: number };
/** 锚点所在边的朝向：左右边水平出线、上下边垂直出线（drawio 正交路由约定） */
function anchorDir(shape: SketchShape, p: Pt): Dir {
  const cx = shape.x + shape.w / 2, cy = shape.y + shape.h / 2;
  return Math.abs(p.x - cx) >= Math.abs(p.y - cy)
    ? { dx: Math.sign(p.x - cx) || 1, dy: 0 }
    : { dx: 0, dy: Math.sign(p.y - cy) || 1 };
}
/** drawio 式正交折线路由：按两端出线方向生成 H-V-H / V-H-V / L 形折线 */
function orthoPath(a: Pt, da: Dir, b: Pt, db: Dir): string {
  if (Math.hypot(b.x - a.x, b.y - a.y) < 0.5) return `M ${a.x} ${a.y} l 6 0`;
  const hA = da.dx !== 0, hB = db.dx !== 0;
  void db;
  if (hA && hB) {
    const mx = (a.x + b.x) / 2;
    return `M ${a.x} ${a.y} L ${mx} ${a.y} L ${mx} ${b.y} L ${b.x} ${b.y}`;
  }
  if (!hA && !hB) {
    const my = (a.y + b.y) / 2;
    return `M ${a.x} ${a.y} L ${a.x} ${my} L ${b.x} ${my} L ${b.x} ${b.y}`;
  }
  if (hA) return `M ${a.x} ${a.y} L ${b.x} ${a.y} L ${b.x} ${b.y}`;
  return `M ${a.x} ${a.y} L ${a.x} ${b.y} L ${b.x} ${b.y}`;
}

export const Sketch = Node.create({
  name: 'sketch',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      data: { default: JSON.stringify({ w: 620, h: 150, shapes: [] }) },
      title: { default: 'sketch' },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-sketch]' }];
  },

  renderHTML({ node }) {
    return ['div', mergeAttributes({ 'data-sketch': '1', 'data-title': String(node.attrs.title ?? '') }), 0];
  },

  addCommands() {
    return {
      insertSketch: () => ({ chain }) => chain().insertContent({ type: 'sketch' }).run(),
    };
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      const wrap = el('div', 'gg-sketch');
      const bar = el('div', 'gg-sketch-bar');
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'gb-sk-svg');
      const defs = document.createElementNS(NS, 'defs');
      defs.innerHTML = '<marker id="gb-sk-arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>';
      const g = document.createElementNS(NS, 'g');
      svg.append(defs, g);
      const t = (window as unknown as { gitboardNotesT?: (k: string) => string }).gitboardNotesT ?? ((k: string) => k);
      // v0.18 反馈 #9：整块删除按钮（画板节点被 NodeSelection 选中时显示）
      const nodeDel = mkNodeDelBtn(editor, getPos, t('notesDeleteBlock'));
      wrap.append(bar, svg, nodeDel);

      let data = parseData(node.attrs.data);
      let tool: Tool = 'select';
      let sel = new Set<string>();
      let dirty = false;

      const commit = (): void => {
        dirty = true;
        const pos = getPos();
        if (typeof pos !== 'number') return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, data: JSON.stringify(data) }));
      };
      const byId = (id?: string): SketchShape | undefined => data.shapes.find(s => s.id === id);

      // ---------- drawio 式网格吸附与板内撤销（v0.16.1） ----------
      const GRID = 10;
      const snap = (v: number): number => Math.round(v / GRID) * GRID;
      let undoStack: SketchData[] = [];
      let redoStack: SketchData[] = [];
      const cloneData = (): SketchData => JSON.parse(JSON.stringify(data)) as SketchData;
      /** 直接变更（删除/文字编辑）前调用：压入撤销栈并清空重做栈 */
      const pushHistory = (): void => {
        undoStack.push(cloneData());
        if (undoStack.length > 50) undoStack.shift();
        redoStack = [];
      };
      const undo = (): void => {
        if (!undoStack.length) return;
        redoStack.push(cloneData());
        data = undoStack.pop()!;
        sel.clear();
        render(); commit();
      };
      const redo = (): void => {
        if (!redoStack.length) return;
        undoStack.push(cloneData());
        data = redoStack.pop()!;
        sel.clear();
        render(); commit();
      };

      // ---------- 渲染 ----------
      const shapeEl = (s: SketchShape, selected: boolean): SVGElement => {
        let n: SVGElement;
        /** 连线端点：坐标 + 出线方向（绑定图形取锚点所在边朝向，自由端点沿主轴） */
        const endpointOf = (which: 'a' | 'b'): { p: Pt; d: Dir } => {
          const other = which === 'a' ? { x: s.x + s.w, y: s.y + s.h } : { x: s.x, y: s.y };
          const px = which === 'a' ? s.x : s.x + s.w;
          const py = which === 'a' ? s.y : s.y + s.h;
          const bound = byId(which === 'a' ? s.src : s.dst);
          if (!bound) {
            const horiz = Math.abs(other.x - px) >= Math.abs(other.y - py);
            return {
              p: { x: px, y: py },
              d: horiz ? { dx: Math.sign(other.x - px) || 1, dy: 0 } : { dx: 0, dy: Math.sign(other.y - py) || 1 },
            };
          }
          const p = nearestAnchor(bound, other.x, other.y);
          return { p, d: anchorDir(bound, p) };
        };
        if (s.kind === 'line' || s.kind === 'arrow') {
          // v0.18 反馈 #5：drawio 式正交折线（默认路由，非直线）
          n = document.createElementNS(NS, 'path');
          const ea = endpointOf('a');
          const eb = endpointOf('b');
          n.setAttribute('d', orthoPath(ea.p, ea.d, eb.p, eb.d));
          if (s.kind === 'arrow') n.setAttribute('marker-end', 'url(#gb-sk-arr)');
        } else if (s.kind === 'text') {
          n = document.createElementNS(NS, 'text');
          n.setAttribute('x', String(s.x + 2)); n.setAttribute('y', String(s.y + s.h / 2 + 4));
          n.setAttribute('class', 'gb-sk-text');
          n.textContent = s.text ?? '';
        } else if (s.kind === 'diamond') {
          // 菱形用路径（无 transform 复合变换）
          n = document.createElementNS(NS, 'path');
          const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
          n.setAttribute('d', `M ${cx} ${s.y} L ${s.x + s.w} ${cy} L ${cx} ${s.y + s.h} L ${s.x} ${cy} Z`);
        } else if (s.kind === 'ellipse') {
          n = document.createElementNS(NS, 'ellipse');
          n.setAttribute('cx', String(s.x + s.w / 2)); n.setAttribute('cy', String(s.y + s.h / 2));
          n.setAttribute('rx', String(Math.max(1, s.w / 2))); n.setAttribute('ry', String(Math.max(1, s.h / 2)));
        } else {
          n = document.createElementNS(NS, 'rect');
          n.setAttribute('x', String(s.x)); n.setAttribute('y', String(s.y));
          n.setAttribute('width', String(Math.max(1, s.w))); n.setAttribute('height', String(Math.max(1, s.h)));
          if (s.kind === 'round') n.setAttribute('rx', '6');
        }
        n.setAttribute('class', 'gb-sk-shape' + (selected ? ' sel' : ''));
        n.dataset.id = s.id;
        return n;
      };

      const labelEl = (s: SketchShape): SVGElement | undefined => {
        if (s.kind === 'text' || !s.text) return undefined;
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', String(s.x + s.w / 2)); t.setAttribute('y', String(s.y + s.h / 2 + 4));
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('class', 'gb-sk-text gb-sk-label');
        t.style.pointerEvents = 'none';
        t.textContent = s.text;
        return t;
      };

      const handleEls = (): SVGElement[] => {
        const out: SVGElement[] = [];
        const single = sel.size === 1 ? byId([...sel][0]) : undefined;
        if (!single) return out;
        // v0.18 反馈 #6：drawio 式小圆点（视觉 r=2.5）+ 隐形加大命中圈（r=7，携带交互数据）
        const dot = (x: number, y: number): SVGElement => {
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
          c.setAttribute('r', '2.5'); c.setAttribute('class', 'gb-sk-dot');
          return c;
        };
        const hit = (x: number, y: number, cls: string): SVGElement => {
          const c = document.createElementNS(NS, 'circle');
          c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
          c.setAttribute('r', '7'); c.setAttribute('class', `${cls} gb-sk-hit`);
          return c;
        };
        if (single.kind === 'line' || single.kind === 'arrow') {
          for (const which of ['a', 'b'] as const) {
            const p = which === 'a'
              ? (byId(single.src) ? nearestAnchor(byId(single.src)!, single.x + single.w, single.y + single.h) : { x: single.x, y: single.y })
              : (byId(single.dst) ? nearestAnchor(byId(single.dst)!, single.x, single.y) : { x: single.x + single.w, y: single.y + single.h });
            const h = hit(p.x, p.y, 'gb-sk-handle');
            h.dataset.handle = which;
            out.push(dot(p.x, p.y), h);
          }
          return out;
        }
        for (const [hx, hy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
          const x = single.x + single.w * hx, y = single.y + single.h * hy;
          const h = hit(x, y, 'gb-sk-handle');
          h.dataset.hx = String(hx); h.dataset.hy = String(hy);
          out.push(dot(x, y), h);
        }
        // drawio 式：选中图形四边中点拖出锚点（按下拖拽即创建绑定连线，无需切换箭头工具）
        for (const [ax, ay] of [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]] as const) {
          const x = single.x + single.w * ax, y = single.y + single.h * ay;
          const h = hit(x, y, 'gb-sk-anchor');
          h.dataset.anchor = '1';
          out.push(dot(x, y), h);
        }
        return out;
      };

      const render = (): void => {
        const used = data.shapes.map(s => Math.max(s.x + s.w, s.y + s.h));
        const w = Math.max(560, ...used, data.w);
        const h = Math.max(130, ...used, data.h);
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        for (const s of data.shapes) {
          if ((s.kind === 'line' || s.kind === 'arrow') && (s.src || s.dst)) {
            // 绑定连线：坐标由绑定图形动态决定（移动图形自动跟随）
            const a = s.src ? nearestAnchor(byId(s.src)!, s.x + s.w, s.y + s.h) : { x: s.x, y: s.y };
            const b = s.dst ? nearestAnchor(byId(s.dst)!, s.x, s.y) : { x: s.x + s.w, y: s.y + s.h };
            s.x = a.x; s.y = a.y; s.w = b.x - a.x; s.h = b.y - a.y;
          }
        }
        g.replaceChildren(...data.shapes.flatMap(s => {
          const els = [shapeEl(s, sel.has(s.id))];
          const label = labelEl(s);
          if (label) els.push(label);
          return els;
        }), ...handleEls());
      };

      // ---------- 工具条 ----------
      const tools: { t: Tool; icon: string; key: string }[] = [
        { t: 'select', icon: '⬚', key: 'notesSketchSelect' },
        { t: 'round', icon: '▢', key: 'notesSketchRound' },
        { t: 'diamond', icon: '◇', key: 'notesSketchDiamond' },
        { t: 'ellipse', icon: '◯', key: 'notesSketchEllipse' },
        { t: 'rect', icon: '▭', key: 'notesSketchRect' },
        { t: 'line', icon: '╱', key: 'notesSketchLine' },
        { t: 'arrow', icon: '→', key: 'notesSketchArrow' },
        { t: 'text', icon: 'T', key: 'notesSketchText' },
      ];
      const btns = new Map<Tool, HTMLButtonElement>();
      for (const { t: tl, icon, key } of tools) {
        const b = el('button', 'gg-tbtn') as HTMLButtonElement;
        b.textContent = icon;
        b.title = t(key);
        b.addEventListener('click', () => {
          tool = tl;
          for (const [k2, bb] of btns) bb.classList.toggle('on', k2 === tool);
        });
        btns.set(tl, b);
        bar.appendChild(b);
      }
      const sep = el('span', 'gg-tsep');
      // v0.18 反馈 #4：显式"编辑文字"入口（双击图形 / 选中后 Enter 亦可）
      const textBtn = el('button', 'gg-tbtn') as HTMLButtonElement;
      textBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M10.8 2.6 L13.4 5.2 L5.9 12.7 L2.6 13.4 L3.3 10.1 Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
      textBtn.title = t('notesSketchEditText');
      textBtn.addEventListener('click', () => {
        const s = sel.size === 1 ? byId([...sel][0]) : undefined;
        if (s) beginTextEdit(s);
      });
      const delBtn = el('button', 'gg-tbtn') as HTMLButtonElement;
      // v0.17：🗑 emoji 在部分环境渲染破损，改用受控内联 SVG
      delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.8h3V4M4 4l.7 9.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.6 7v4.5M9.4 7v4.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>';
      delBtn.title = t('notesSketchDelete');
      delBtn.addEventListener('click', deleteSelection);
      const undoBtn = el('button', 'gg-tbtn') as HTMLButtonElement;
      undoBtn.textContent = '⟲';
      undoBtn.title = t('notesSketchUndo');
      undoBtn.addEventListener('click', undo);
      const redoBtn = el('button', 'gg-tbtn') as HTMLButtonElement;
      redoBtn.textContent = '⟳';
      redoBtn.title = t('notesSketchRedo');
      redoBtn.addEventListener('click', redo);
      const tip = el('span', 'gg-sketch-tip', t('notesSketchTip'));
      bar.append(sep, textBtn, delBtn, undoBtn, redoBtn, tip);

      function deleteSelection(): void {
        if (!sel.size) return;
        pushHistory();
        data.shapes = data.shapes.filter(s => !sel.has(s.id) && !(s.src && sel.has(s.src)) && !(s.dst && sel.has(s.dst)));
        sel.clear();
        render(); commit();
      }

      // ---------- 交互状态机 ----------
      type Drag =
        | { mode: 'place'; id: string; startX: number; startY: number; moved: boolean }
        | { mode: 'move'; ids: string[]; startX: number; startY: number; orig: Map<string, SketchShape> }
        | { mode: 'resize'; id: string; hx: 0 | 1; hy: 0 | 1; orig: SketchShape }
        | { mode: 'connect'; id: string; which: 'a' | 'b'; orig: SketchShape }
        | { mode: 'newconnect'; id: string }   // 从选中图形边缘锚点拖出新连线（drawio 式）
        | { mode: 'marquee'; startX: number; startY: number }
        | undefined;
      let drag: Drag;
      /** 拖拽开始时的数据快照（结束时若有实际变更才入撤销栈——点击选中不产生历史） */
      let downSnap: SketchData | undefined;
      let marqueeEl: SVGElement | undefined;

      const toSvg = (e: PointerEvent): { x: number; y: number } => {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        return { x: ((e.clientX - r.left) / Math.max(1, r.width)) * vb.width, y: ((e.clientY - r.top) / Math.max(1, r.height)) * vb.height };
      };
      const hitShape = (p: { x: number; y: number }): SketchShape | undefined =>
        [...data.shapes].reverse().find(s => s.kind !== 'line' && s.kind !== 'arrow' && inShape(s, p.x, p.y));
      const hitLine = (p: { x: number; y: number }): SketchShape | undefined =>
        [...data.shapes].reverse().find(s => (s.kind === 'line' || s.kind === 'arrow') && inRect({
          x: Math.min(s.x, s.x + s.w) - 4, y: Math.min(s.y, s.y + s.h) - 4,
          w: Math.abs(s.w) + 8, h: Math.abs(s.h) + 8,
        }, p.x, p.y));

      svg.addEventListener('pointerdown', e => {
        e.preventDefault();
        // v0.18 反馈 #3：画布交互时焦点移入画板容器（tabIndex=-1），Delete 走板内删除逻辑，
        // 不再落到 ProseMirror 的 NodeSelection 上把整个画板删掉
        wrap.focus();
        const p = toSvg(e);
        const anchor = (e.target as Element).closest('.gb-sk-anchor') as SVGElement | null;
        const handle = (e.target as Element).closest('.gb-sk-handle') as SVGCircleElement | null;
        const shapeNodeEl = (e.target as Element).closest('.gb-sk-shape') as SVGElement | null;
        downSnap = undefined;

        if (tool === 'select') {
          // drawio 式：从选中图形的边缘锚点按下 → 拖出一条新箭头连线
          if (anchor && sel.size === 1) {
            const src = byId([...sel][0]);
            if (src && src.kind !== 'line' && src.kind !== 'arrow') {
              downSnap = cloneData();
              const from = nearestAnchor(src, p.x, p.y);
              const s: SketchShape = { id: uid(), kind: 'arrow', x: from.x, y: from.y, w: 0, h: 0, src: src.id };
              data.shapes.push(s);
              sel = new Set([s.id]);
              drag = { mode: 'newconnect', id: s.id };
              render();
              return;
            }
          }
          if (handle && sel.size === 1) {
            const id = [...sel][0];
            const s = byId(id)!;
            downSnap = cloneData();
            if (s.kind === 'line' || s.kind === 'arrow') {
              drag = { mode: 'connect', id, which: handle.dataset.handle as 'a' | 'b', orig: { ...s } };
            } else {
              drag = { mode: 'resize', id, hx: Number(handle.dataset.hx) as 0 | 1, hy: Number(handle.dataset.hy) as 0 | 1, orig: { ...s } };
            }
            return;
          }
          const id = shapeNodeEl?.dataset.id;
          if (id) {
            if (e.ctrlKey || e.metaKey) {
              if (sel.has(id)) sel.delete(id); else sel.add(id);
            } else if (!sel.has(id)) {
              sel = new Set([id]);
            }
            const ids = [...sel];
            downSnap = cloneData();
            drag = { mode: 'move', ids, startX: p.x, startY: p.y, orig: new Map(ids.map(i2 => [i2, { ...byId(i2)! }])) };
            render();
            return;
          }
          const line = hitLine(p);
          if (line && sel.has(line.id)) {
            drag = { mode: 'move', ids: [line.id], startX: p.x, startY: p.y, orig: new Map([[line.id, { ...line }]]) };
            return;
          }
          if (line) {
            sel = new Set([line.id]);
            render();
            return;
          }
          sel.clear();
          drag = { mode: 'marquee', startX: p.x, startY: p.y };
          render();
          return;
        }

        // 放置工具：拖拽出尺寸；松手时位移过小 → 默认尺寸（drawio 式点击放置）
        const size = DEFAULT_SIZE[tool];
        downSnap = cloneData();
        const s: SketchShape = {
          id: uid(), kind: tool,
          x: snap(p.x), y: snap(p.y), w: 0, h: 0,
          ...(tool === 'text' ? { text: '' } : {}),
        };
        data.shapes.push(s);
        sel = new Set([s.id]);
        drag = { mode: 'place', id: s.id, startX: p.x, startY: p.y, moved: false };
        if (tool === 'line' || tool === 'arrow') { s.w = 0; s.h = 0; }
        else { s.w = 1; s.h = 1; }
        render();
      });

      window.addEventListener('pointermove', ev => {
        if (!drag) return;
        const p = toSvg(ev);
        if (drag.mode === 'place') {
          const s = byId(drag.id)!;
          const dx = Math.abs(p.x - drag.startX), dy = Math.abs(p.y - drag.startY);
          if (dx > 6 || dy > 6) drag.moved = true;
          if (drag.moved && s.kind !== 'text') {
            s.x = snap(Math.min(drag.startX, p.x)); s.y = snap(Math.min(drag.startY, p.y));
            s.w = Math.max(10, snap(dx)); s.h = Math.max(10, snap(dy));
          } else if ((s.kind === 'line' || s.kind === 'arrow') && (dx > 4 || dy > 4)) {
            drag.moved = true;
            s.x = drag.startX; s.y = drag.startY;
            s.w = snap(p.x - drag.startX); s.h = snap(p.y - drag.startY);
          }
          render();
          return;
        }
        if (drag.mode === 'newconnect') {
          const s = byId(drag.id)!;
          const target = hitShape(p);
          const end = target && target.id !== s.src ? nearestAnchor(target, p.x, p.y) : { x: snap(p.x), y: snap(p.y) };
          s.w = end.x - s.x; s.h = end.y - s.y;
          render();
          return;
        }
        if (drag.mode === 'move') {
          const dx = snap(p.x - drag.startX), dy = snap(p.y - drag.startY);
          for (const id of drag.ids) {
            const s = byId(id)!;
            const o = drag.orig.get(id)!;
            s.x = o.x + dx; s.y = o.y + dy;
          }
          render();
          return;
        }
        if (drag.mode === 'resize') {
          const s = byId(drag.id)!;
          const o = drag.orig;
          const x1 = drag.hx === 0 ? snap(p.x) : o.x;
          const y1 = drag.hy === 0 ? snap(p.y) : o.y;
          const x2 = drag.hx === 1 ? snap(p.x) : o.x + o.w;
          const y2 = drag.hy === 1 ? snap(p.y) : o.y + o.h;
          s.x = Math.min(x1, x2); s.y = Math.min(y1, y2);
          s.w = Math.max(10, Math.abs(Math.round(x2 - x1))); s.h = Math.max(10, Math.abs(Math.round(y2 - y1)));
          render();
          return;
        }
        if (drag.mode === 'connect') {
          const s = byId(drag.id)!;
          const o = drag.orig;
          if (drag.which === 'a') { s.x = p.x; s.y = p.y; s.w = o.x + o.w - p.x; s.h = o.y + o.h - p.y; }
          else { s.w = p.x - o.x; s.h = p.y - o.y; }
          // 吸附到最近图形锚点
          const target = hitShape(p);
          if (target && target.id !== s.id) {
            const a = nearestAnchor(target, p.x, p.y);
            if (drag.which === 'a') { s.x = a.x; s.y = a.y; s.w = o.x + o.w - a.x; s.h = o.y + o.h - a.y; }
            else { s.w = a.x - o.x; s.h = a.y - o.y; }
          }
          render();
          return;
        }
        if (drag.mode === 'marquee') {
          const x = Math.min(drag.startX, p.x), y = Math.min(drag.startY, p.y);
          const w = Math.abs(p.x - drag.startX), h = Math.abs(p.y - drag.startY);
          if (!marqueeEl) {
            marqueeEl = document.createElementNS(NS, 'rect');
            marqueeEl.setAttribute('class', 'gb-sk-marquee');
            g.appendChild(marqueeEl);
          }
          marqueeEl.setAttribute('x', String(x)); marqueeEl.setAttribute('y', String(y));
          marqueeEl.setAttribute('width', String(w)); marqueeEl.setAttribute('height', String(h));
          sel = new Set(data.shapes.filter(s => s.kind !== 'line' && s.kind !== 'arrow'
            && s.x >= x && s.y >= y && s.x + s.w <= x + w + 4 && s.y + s.h <= y + h + 4).map(s => s.id));
          render();
          if (!marqueeEl.isConnected) g.appendChild(marqueeEl);
          return;
        }
      });

      window.addEventListener('pointerup', () => {
        if (!drag) return;
        if (drag.mode === 'place') {
          const s = byId(drag.id)!;
          if (!drag.moved) {
            // 点击放置默认尺寸（drawio 式；坐标吸附网格）
            const size = DEFAULT_SIZE[s.kind];
            s.x = snap(drag.startX); s.y = snap(drag.startY);
            s.w = size.w; s.h = size.h;
          }
          if (s.kind === 'line' || s.kind === 'arrow') {
            // 放置连线：端点若落在图形内则绑定
            const aPt = { x: s.x, y: s.y };
            const bPt = { x: s.x + s.w, y: s.y + s.h };
            const src = hitShape(aPt);
            const dst = hitShape(bPt);
            if (src) s.src = src.id;
            if (dst) s.dst = dst.id;
          }
          tool = 'select';
          for (const [k2, bb] of btns) bb.classList.toggle('on', k2 === 'select');
        }
        if (drag.mode === 'newconnect') {
          const s = byId(drag.id)!;
          const target = hitShape({ x: s.x + s.w, y: s.y + s.h });
          if (target && target.id !== s.src) {
            const end = nearestAnchor(target, s.x + s.w, s.y + s.h);
            s.w = end.x - s.x; s.h = end.y - s.y;
            s.dst = target.id;
          } else if (Math.hypot(s.w, s.h) < 8) {
            // 过短拖拽视为误触：丢弃新连线且不产生历史
            data.shapes = data.shapes.filter(x => x.id !== s.id);
            sel.clear();
            downSnap = undefined;
          }
        }
        if (drag.mode === 'connect') {
          const s = byId(drag.id)!;
          if (drag.which === 'a') {
            const target = hitShape({ x: s.x, y: s.y });
            s.src = target && target.id !== s.id ? target.id : drag.orig.src;
            s.x = drag.orig.x; s.y = drag.orig.y;
          } else {
            const target = hitShape({ x: s.x + s.w, y: s.y + s.h });
            s.dst = target && target.id !== s.id ? target.id : drag.orig.dst;
            s.w = drag.orig.w; s.h = drag.orig.h;
          }
        }
        if (drag.mode === 'marquee' && marqueeEl) {
          marqueeEl.remove();
          marqueeEl = undefined;
        }
        // 拖拽历史：与按下时快照比对，有实际变更才入撤销栈（点击选中不产生历史）
        if (downSnap) {
          if (JSON.stringify(downSnap) !== JSON.stringify(data)) {
            undoStack.push(downSnap);
            if (undoStack.length > 50) undoStack.shift();
            redoStack = [];
          }
          downSnap = undefined;
        }
        drag = undefined;
        render(); commit();
      });

      // v0.18 反馈 #4：图形文字编辑统一入口（双击图形 / 选中后 Enter / 工具栏按钮）
      let editInput: HTMLInputElement | undefined;
      const beginTextEdit = (s: SketchShape): void => {
        if (s.kind === 'line' || s.kind === 'arrow' || editInput) return;
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const scale = r.width / vb.width;
        editInput = el('input', 'gb-sk-edit') as HTMLInputElement;
        editInput.value = s.text ?? '';
        editInput.style.left = `${r.left + s.x * scale}px`;
        editInput.style.top = `${r.top + s.y * scale}px`;
        editInput.style.width = `${Math.max(60, s.w * scale)}px`;
        const commitText = (): void => {
          if (!editInput) return;
          if (editInput.value !== (s.text ?? '')) pushHistory();
          s.text = editInput.value;
          editInput.remove();
          editInput = undefined;
          render(); commit();
        };
        editInput.addEventListener('keydown', ev2 => {
          ev2.stopPropagation();
          if (ev2.key === 'Enter' || ev2.key === 'Escape') commitText();
        });
        editInput.addEventListener('blur', commitText);
        document.body.appendChild(editInput);
        setTimeout(() => { editInput?.focus(); editInput?.select(); }, 0);
      };
      svg.addEventListener('dblclick', e => {
        const node = (e.target as Element).closest('.gb-sk-shape') as SVGElement | null;
        const s = byId(node?.dataset.id);
        if (s) beginTextEdit(s);
      });

      wrap.addEventListener('keydown', e => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) {
          const selection = window.getSelection();
          if (selection && selection.toString()) return;
          deleteSelection();
          e.preventDefault();
        }
        if (e.key === 'Enter' && sel.size === 1) {
          const s = byId([...sel][0]);
          if (s) { e.preventDefault(); beginTextEdit(s); }
        }
        if (e.key === 'Escape') {
          sel.clear();
          tool = 'select';
          for (const [k2, bb] of btns) bb.classList.toggle('on', k2 === 'select');
          render();
        }
      });
      wrap.tabIndex = -1;

      render();
      return {
        dom: wrap,
        update(newNode: any) {
          if (newNode.type.name !== 'sketch') return false;
          const incoming = parseData(newNode.attrs.data);
          if (JSON.stringify(incoming) === JSON.stringify(data)) return true;
          if (!dirty) {
            data = incoming;
            render();
          }
          dirty = false;
          return true;
        },
        selectNode() { wrap.classList.add('sel'); },
        deselectNode() { wrap.classList.remove('sel'); },
      };
    };
  },
});
