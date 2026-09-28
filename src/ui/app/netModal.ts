/**
 * 阻塞式进度弹窗（#41，SourceTree 式；#89 扩至本地重操作）：
 * Fetch/Pull/Push/Checkout/分支删除 执行期间弹出模态窗，半透明遮罩挡住下层主页面（灰化=禁用，
 * 点击不穿透）——#89 动机：删除/签出等操作延迟期间 UI 仍开放，用户重复点击造成重复删除/签出。
 * 展示操作名（#88 批量检出时为「k/N · 分支名」）、进度条（百分比/不定态）、git 实时输出行、耗时与取消按钮
 * （取消仅网络三类——本地 checkout/branchDelete 无取消语义，按钮按 kind 隐藏）。
 * 成功绿色完成态短显后自动关闭；失败/取消立即关闭，交给既有错误通知流（重试/AI 分析）。
 * 「拉取并推送」/「批量检出」链条：完成态留 700ms 宽限窗，链上下一个操作到达则无缝续接不闪烁。
 */
import { S, type App } from '../state';
import { el } from '../util';
import { iconSvg, type IconName } from '../icons';

const NET_MODAL_KINDS = new Set(['fetch', 'pull', 'push', 'checkout', 'branchDelete']);
const KIND_ICON: Record<string, IconName> = {
  fetch: 'syncFetch', pull: 'pullDown', push: 'pushUp', checkout: 'branch', branchDelete: 'trash',
};
/** 无取消语义的本地操作（#89）：模态隐藏取消按钮 */
const NO_CANCEL_KINDS = new Set(['checkout', 'branchDelete']);
/** 成功完成态展示时长（期间链上下一个操作可无缝接管） */
const DONE_FLASH_MS = 700;

/** opProgress / opResult 事件的最小切片（避免引入全量协议类型） */
interface OpProgressLike { opId: number; kind: string; text: string; pct?: number; queued?: boolean; position?: number }
interface OpResultLike { opId: number; kind: string; ok: boolean; verify?: 'pass' | 'warn' | 'unknown'; cancelled?: boolean; message?: string }

export interface NetModal {
  onProgress(m: OpProgressLike): void;
  onResult(m: OpResultLike): void;
  /** #88 批量检出：标题覆盖（「检出 k/N · 名」）；open() 重置标题时沿用；undefined 恢复默认 */
  setBatch(label?: string): void;
}

export function createNetModal(app: App): NetModal {
  let overlay: HTMLElement | undefined;
  let box: HTMLElement | undefined;
  let iconEl: HTMLElement | undefined;
  let titleEl: HTMLElement | undefined;
  let fill: HTMLElement | undefined;
  let bar: HTMLElement | undefined;
  let pctEl: HTMLElement | undefined;
  let textEl: HTMLElement | undefined;
  let timeEl: HTMLElement | undefined;
  let cancelEl: HTMLButtonElement | undefined;

  let opId: number | undefined;
  let startedAt = 0;
  let ticker: number | undefined;
  let closeTimer: number | undefined;
  /** #88 批量检出标题覆盖（open() 重置时沿用；done/close 后由调用方清除） */
  let batchLabel: string | undefined;

  function setIcon(name: IconName): void {
    iconEl!.textContent = '';
    iconEl!.appendChild(iconSvg(name));
  }

  function fmtElapsed(ms: number): string {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  }

  function stopTicker(): void {
    if (ticker !== undefined) { clearInterval(ticker); ticker = undefined; }
  }

  /** 开窗（首次惰性建 DOM）并按操作类型初始化 */
  function open(kind: string): void {
    if (!overlay) {
      overlay = el('div', 'gg-net-overlay');
      box = el('div', 'gg-net-box');
      const head = el('div', 'gg-net-head');
      iconEl = el('span', 'gg-net-ic');
      titleEl = el('span', 'gg-net-title');
      head.append(iconEl, titleEl);
      bar = el('div', 'gg-net-bar');
      fill = el('div', 'gg-net-fill');
      bar.append(fill);
      textEl = el('div', 'gg-net-text');
      const foot = el('div', 'gg-net-foot');
      timeEl = el('span', 'gg-net-time');
      pctEl = el('span', 'gg-net-pct');
      const cancel = el('button', 'gg-btn small', S.t('cancel')) as HTMLButtonElement;
      cancel.addEventListener('click', () => { if (opId !== undefined) app.cancelOp(opId); });
      cancelEl = cancel;
      foot.append(timeEl, el('span', 'gg-net-gap'), pctEl, cancel);
      box.append(head, bar, textEl, foot);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    }
    box!.classList.remove('done', 'warn');
    setIcon(KIND_ICON[kind] ?? 'hourglass');
    titleEl!.textContent = batchLabel ?? S.t(kind);
    // #89：本地操作无取消语义 → 隐藏取消按钮（网络三类保留）
    cancelEl!.style.display = NO_CANCEL_KINDS.has(kind) ? 'none' : '';
    bar!.classList.add('indet');
    fill!.style.width = '';
    pctEl!.textContent = '';
    textEl!.textContent = '';
    textEl!.classList.add('empty');
    opId = undefined;   // 由 onProgress 绑定真实 opId
    if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
    startedAt = Date.now();
    timeEl!.textContent = '0.0s';
    stopTicker();
    ticker = window.setInterval(() => {
      if (startedAt) timeEl!.textContent = fmtElapsed(Date.now() - startedAt);
    }, 500);
  }

  function close(): void {
    overlay?.remove();
    overlay = box = undefined;
    batchLabel = undefined;   // #88：关窗即清批量标题，防泄漏到下一次单操作
    stopTicker();
    if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
    opId = undefined;
    startedAt = 0;
  }

  function setBatch(label?: string): void {
    batchLabel = label;
    if (label && titleEl && overlay) titleEl.textContent = label;
  }

  function onProgress(m: OpProgressLike): void {
    if (!NET_MODAL_KINDS.has(m.kind)) return;
    // 未开窗、或宽限窗内链上下一个操作（opId 变化）→ 开新窗/原地重置（open 复用 DOM）
    if (!overlay || m.opId !== opId) open(m.kind);
    opId = m.opId;
    const hasPct = typeof m.pct === 'number' && m.pct >= 0;
    bar!.classList.toggle('indet', !hasPct);
    fill!.style.width = hasPct ? `${Math.min(100, m.pct!)}%` : '';
    pctEl!.textContent = hasPct ? `${Math.min(100, m.pct!)}%` : '';
    const queued = m.queued === true;
    textEl!.textContent = queued ? S.t('opQueued', { n: m.position ?? 1 }) : (m.text || '');
    textEl!.classList.toggle('empty', !queued && !m.text);
    if (queued) setIcon('hourglass');
    else setIcon(KIND_ICON[m.kind] ?? 'hourglass');
  }

  function onResult(m: OpResultLike): void {
    if (!NET_MODAL_KINDS.has(m.kind) || m.opId !== opId || !overlay) return;
    if (!m.ok) { close(); return; }   // 失败/取消：立即关闭，错误通知流接管
    // 成功：完成态（图标/标题/满条），留宽限窗给「拉取并推送」链条续接。
    // #45：校验警示（verify=warn，假成功）走琥珀色而非绿色——不被阻塞弹窗「洗白」，
    // 右下角另有琥珀 warn 通知（z 1300 在遮罩之上）
    const warn = m.verify === 'warn';
    box!.classList.add('done');
    box!.classList.toggle('warn', warn);
    setIcon(warn ? 'warnTriangle' : 'checkCircle');
    // #95：完成态标题优先用宿主已插值的 message（如「Local branch dev deleted」），
    // 回退 ${kind}Done 键——该键可能带 {name} 占位符，裸取会显示字面量
    titleEl!.textContent = m.message || S.t(`${m.kind}Done`);
    bar!.classList.remove('indet');
    fill!.style.width = '100%';
    pctEl!.textContent = '';
    textEl!.textContent = '';
    timeEl!.textContent = fmtElapsed(Date.now() - startedAt);
    stopTicker();
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      closeTimer = undefined;
      if (opId === m.opId) close();
    }, DONE_FLASH_MS);
  }

  return { onProgress, onResult, setBatch };
}
