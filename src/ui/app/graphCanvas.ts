/**
 * 图形列 Canvas 绘制层（设计方案 5.3 / 5.4）：
 * 只绘可视区、devicePixelRatio 缩放、短半径圆角（k = ROW_H/4）、angular 可选。
 */
import type { Curve } from '../../graph/lanes';
import { S } from '../state';

const PADDING = 8;
const LANE_W = 11;

const PALETTE_VARS = [
  '--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green',
  '--vscode-charts-purple', '--vscode-charts-yellow', '--vscode-charts-red',
];
const PALETTE_FALLBACK_DARK = ['#4fc1ff', '#f0883e', '#3fb950', '#a371f7', '#d29922', '#f85149'];

export class GraphCanvas {
  readonly canvas = document.createElement('canvas');
  private scrollEl!: HTMLElement;
  private curvesByRow = new Map<number, Curve[]>();
  private colors: string[] = [];
  private lastWidth = 0;
  private lastHeight = 0;
  private laneCount = 1;
  private userGraphWidth = 0;

  constructor() {
    this.canvas.className = 'gg-graph-canvas';
  }

  attach(scrollEl: HTMLElement): void {
    this.scrollEl = scrollEl;
  }

  /** lanes 重算后调用 */
  onGraphChanged(laneCount: number, curves: Curve[]): void {
    this.curvesByRow = new Map();
    for (const c of curves) {
      const list = this.curvesByRow.get(c.row);
      if (list) list.push(c); else this.curvesByRow.set(c.row, [c]);
    }
    this.laneCount = Math.max(1, laneCount);
    this.recomputeWidth();
  }

  /** 用户拖拽图形列宽后调用 */
  setUserGraphWidth(w: number): void {
    if (this.userGraphWidth === w) return;
    this.userGraphWidth = w;
    this.recomputeWidth();
  }

  private recomputeWidth(): void {
    const need = PADDING * 2 + this.laneCount * LANE_W;
    this.lastWidth = Math.max(this.userGraphWidth || S.config.graphColumnWidth, need);
  }

  get graphWidth(): number {
    return this.lastWidth || S.config.graphColumnWidth;
  }

  redraw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !S.graph || !this.scrollEl) return;
    this.readColors();
    const dpr = window.devicePixelRatio || 1;
    const w = this.graphWidth;
    const h = this.scrollEl.clientHeight;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const R = S.config.rowHeightPx;
    const scrollTop = this.scrollEl.scrollTop;
    const n = S.commits.length;
    const first = Math.max(0, Math.floor(scrollTop / R) - 1);
    const last = Math.min(n - 1, Math.ceil((scrollTop + h) / R));
    const yc = (row: number) => row * R + R / 2 - scrollTop;
    const x = (lane: number) => PADDING + lane * LANE_W;
    const segColor = (seg: number) => this.colors[((seg % this.colors.length) + this.colors.length) % this.colors.length];
    const angular = S.config.graphStyle === 'angular';

    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // 1) 竖线：activeBelow[r] 为第 r 行下方仍活跃的 lane。
    //    本行 fork/mergeOut 的目标 lane 整段由 S 曲线接管（跳过竖线）；
    //    下一行 mergeIn 收编的 lane，竖线提前半行收尾，余下交给肘形曲线。
    const { activeBelow } = S.graph;
    for (let r = Math.max(0, first - 1); r <= Math.min(n - 1, last); r++) {
      const yTop = yc(r);
      const yBottom = r === n - 1 ? yTop + R : yc(r + 1);
      if (yBottom < -R || yTop > h + R) continue;
      const takenHere = new Set<number>();
      for (const cv of this.curvesByRow.get(r) ?? []) {
        if (cv.kind !== 'mergeIn') takenHere.add(cv.toLane);
      }
      const stopEarly = new Map<number, number>();
      for (const cv of this.curvesByRow.get(r + 1) ?? []) {
        if (cv.kind === 'mergeIn') stopEarly.set(cv.fromLane, yBottom - R / 2);
      }
      for (const a of activeBelow[r] ?? []) {
        if (takenHere.has(a.lane)) continue;
        const yStop = Math.min(yBottom, stopEarly.get(a.lane) ?? yBottom);
        if (yStop - yTop < 0.5) continue;
        ctx.strokeStyle = segColor(a.seg);
        ctx.beginPath();
        ctx.moveTo(x(a.lane), yTop);
        ctx.lineTo(x(a.lane), yStop);
        ctx.stroke();
      }
    }

    // 2) 曲线：fork/mergeOut 整行高 S 曲线（起止切线竖直）柔和换轨；
    //    mergeIn 自上方竖线半行处以肘形曲线汇入提交点（替代生硬水平线）。
    for (let r = first; r <= last; r++) {
      const y0 = yc(r);
      if (y0 < -R || y0 > h + R) continue;
      for (const cv of this.curvesByRow.get(r) ?? []) {
        const x1 = x(cv.fromLane);
        const x2 = x(cv.toLane);
        if (cv.kind === 'mergeIn') {
          ctx.strokeStyle = segColor(cv.seg);
          ctx.beginPath();
          ctx.moveTo(x1, y0 - R / 2);
          if (angular) {
            ctx.lineTo(x2, y0);
          } else {
            ctx.bezierCurveTo(x1, y0, (x1 + x2) / 2, y0, x2, y0);
          }
          ctx.stroke();
        } else {
          ctx.strokeStyle = segColor(cv.seg);
          const y1 = y0 + R;
          ctx.beginPath();
          ctx.moveTo(x1, y0);
          if (angular) {
            ctx.lineTo(x2, y0 + R / 2);
            ctx.lineTo(x2, y1);
          } else if (x1 === x2) {
            ctx.lineTo(x2, y1);
          } else {
            ctx.bezierCurveTo(x1, y0 + R / 2, x2, y0 + R / 2, x2, y1);
          }
          ctx.stroke();
        }
      }
    }

    // 3) 节点（普通/合并外环/HEAD 描边）
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    for (let r = first; r <= last; r++) {
      const c = S.commits[r];
      const y0 = yc(r);
      if (y0 < -R || y0 > h + R) continue;
      const cx = x(c.lane ?? 0);
      const isHead = c.refs.some(ref => ref.isHead);
      const isMerge = c.parents.length > 1;
      const radius = Math.max(2.5, Math.min(4.5, R * 0.16));
      const color = segColor(c.seg ?? c.lane ?? 0);
      if (isMerge) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, y0, radius + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.strokeStyle = isHead ? cssVar('--vscode-charts-red', '#f85149') : bg;
      ctx.lineWidth = isHead ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, y0, isHead ? radius + 0.5 : radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private readColors(): void {
    const dark = isDark(cssVar('--vscode-editor-background', '#1e1e1e'));
    this.colors = PALETTE_VARS.map((v, i) => {
      const val = cssVar(v, '');
      if (val) return val;
      // 浅色主题下 fallback 换用更深的变体
      return dark ? PALETTE_FALLBACK_DARK[i] : shade(PALETTE_FALLBACK_DARK[i], -0.25);
    });
  }
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function isDark(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return true;
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum < 128;
}

/** 简单明度调整（浅色主题 fallback 用） */
function shade(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const ch = (shift: number) => Math.max(0, Math.min(255, Math.round(((n >> shift) & 255) * (1 + amount))));
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}
