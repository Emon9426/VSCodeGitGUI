/**
 * 图形列 Canvas 绘制层（设计方案 5.3 / 5.4）：
 * 只绘可视区、devicePixelRatio 缩放、短半径圆角（k = ROW_H/4）、angular 可选。
 */
import type { Curve } from '../../graph/lanes';
import { S } from '../state';

const PADDING = 8;
const LANE_W = 11;
/** 纯提交视图的时间线列宽（固定窄列：竖线 + 每提交一个圆点） */
const PURE_W = 28;

const PALETTE_VARS = [
  '--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green',
  '--vscode-charts-purple', '--vscode-charts-yellow', '--vscode-charts-red',
];
const PALETTE_FALLBACK_DARK = ['#4fc1ff', '#f0883e', '#3fb950', '#a371f7', '#d29922', '#f85149'];
/** GitHub 风固定配色（不取主题 charts 变量，按编辑器背景明暗二选一；v0.14.6 起为默认风格） */
const GITHUB_DARK = ['#8957e5', '#316dca', '#2ea043', '#d29922', '#db61a2', '#e7811d'];
const GITHUB_LIGHT = ['#8250df', '#0969da', '#1a7f37', '#9a6700', '#bf3989', '#bc4c00'];

/** lane 槽位宽度：github 风稍宽（12px）以容纳双段圆弧转弯 */
const laneW = (): number => (S.config.graphStyle === 'github' ? 12 : LANE_W);

export class GraphCanvas {
  readonly canvas = document.createElement('canvas');
  private scrollEl!: HTMLElement;
  private curvesByRow = new Map<number, Curve[]>();
  private colors: string[] = [];
  private lastWidth = 0;
  private lastHeight = 0;
  private laneCount = 1;
  private userGraphWidth = 0;
  /** 纯提交视图模式：单列时间线（setPure 切换并重算列宽） */
  private pure = false;

  constructor() {
    this.canvas.className = 'gg-graph-canvas';
  }

  attach(scrollEl: HTMLElement): void {
    this.scrollEl = scrollEl;
  }

  /** 视图模式切换（graph=完整拓扑多 lane；pure=固定窄列时间线），列宽随之重算 */
  setPure(pure: boolean): void {
    if (this.pure === pure) return;
    this.pure = pure;
    this.recomputeWidth();
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
    if (this.pure) { this.lastWidth = PURE_W; return; }
    const need = PADDING * 2 + this.laneCount * laneW();
    this.lastWidth = Math.max(this.userGraphWidth || S.config.graphColumnWidth, need);
  }

  get graphWidth(): number {
    return this.lastWidth || S.config.graphColumnWidth;
  }

  redraw(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx || !S.graph || !this.scrollEl) return;
    if (this.pure) { this.redrawPure(ctx); return; }
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
    const x = (lane: number) => PADDING + lane * laneW();
    const segColor = (seg: number) => this.colors[((seg % this.colors.length) + this.colors.length) % this.colors.length];
    const angular = S.config.graphStyle === 'angular';
    const github = S.config.graphStyle === 'github';

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
          } else if (github) {
            // GitHub 风汇入：竖线短距离后四分之一圆弧拐入节点
            const r = Math.min(R / 2.6, Math.abs(x2 - x1));
            const s = Math.sign(x2 - x1);
            ctx.lineTo(x1, y0 - r);
            ctx.quadraticCurveTo(x1, y0, x1 + s * r, y0);
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
          } else if (github) {
            // GitHub 风换轨：两端四分之一圆弧 + 中段短水平，节点处即起弯
            const r = Math.min(R / 2.6, Math.abs(x2 - x1));
            const s = Math.sign(x2 - x1);
            const yMid = y0 + R / 2;
            ctx.quadraticCurveTo(x1, y0 + r, x1 + s * r, yMid);
            ctx.lineTo(x2 - s * r, yMid);
            ctx.quadraticCurveTo(x2, yMid, x2, yMid + r);
            ctx.lineTo(x2, y1);
          } else {
            ctx.bezierCurveTo(x1, y0 + R / 2, x2, y0 + R / 2, x2, y1);
          }
          ctx.stroke();
        }
      }
    }

    // 3) 节点：普通=实心圆；合并=同色外环；HEAD=SourceTree 式醒目空心圆环（主题红）
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    for (let r = first; r <= last; r++) {
      const c = S.commits[r];
      const y0 = yc(r);
      if (y0 < -R || y0 > h + R) continue;
      const cx = x(c.lane ?? 0);
      const isHead = c.refs.some(ref => ref.isHead);
      const isMerge = c.parents.length > 1;
      const radius = github ? 3.2 : Math.max(2.5, Math.min(4.5, R * 0.16));
      const color = segColor(c.seg ?? c.lane ?? 0);
      if (github) {
        // GitHub 风节点：实心小圆点；合并=空心环（背景内芯）；HEAD=背景色粗边强调（无红环）
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, y0, radius, 0, Math.PI * 2);
        ctx.fill();
        if (isMerge) {
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.arc(cx, y0, radius - 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
        if (isHead) {
          ctx.strokeStyle = bg;
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(cx, y0, radius + 1.2, 0, Math.PI * 2);
          ctx.stroke();
        }
        continue;
      }
      if (isMerge && !isHead) {   // HEAD 已有更大的红环，不再叠加同色环
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, y0, radius + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = color;
      ctx.strokeStyle = bg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, y0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (isHead) {
        // 当前 HEAD：醒目圆环标记（半径 +2.5，不越相邻 lane 走线间距 LANE_W=11）
        ctx.strokeStyle = cssVar('--vscode-charts-red', '#f85149');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, y0, radius + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  /**
   * 纯提交视图时间线：列中央一条竖线贯穿可视区，每个提交一个圆点；
   * HEAD 沿用提交图的红色圆环标注；圆点描边用编辑器背景色抠出竖线。
   */
  private redrawPure(ctx: CanvasRenderingContext2D): void {
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
    const n = S.commits.length;
    if (!n) return;
    const scrollTop = this.scrollEl.scrollTop;
    const first = Math.max(0, Math.floor(scrollTop / R) - 1);
    const last = Math.min(n - 1, Math.ceil((scrollTop + h) / R));
    const yc = (row: number) => row * R + R / 2 - scrollTop;
    const cx = w / 2;
    const color = cssVar('--vscode-charts-blue', '#4fc1ff');

    // 竖线：连接首尾行圆心；列表还有更多行时延伸到视口边缘
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, first > 0 ? 0 : yc(first));
    ctx.lineTo(cx, last < n - 1 ? h : yc(last));
    ctx.stroke();

    const radius = Math.max(2.5, Math.min(4.5, R * 0.16));
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    for (let r = first; r <= last; r++) {
      const c = S.commits[r];
      const y0 = yc(r);
      if (y0 < -R || y0 > h + R) continue;
      ctx.fillStyle = color;
      ctx.strokeStyle = bg;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, y0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (c.refs.some(ref => ref.isHead)) {
        ctx.strokeStyle = cssVar('--vscode-charts-red', '#f85149');
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, y0, radius + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  private readColors(): void {
    const dark = isDark(cssVar('--vscode-editor-background', '#1e1e1e'));
    if (S.config.graphStyle === 'github') {
      this.colors = dark ? GITHUB_DARK : GITHUB_LIGHT;
      return;
    }
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
