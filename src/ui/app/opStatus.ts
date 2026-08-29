/**
 * 操作进度行（v0.9.2）：工具栏下方的状态条，显示 Fetch/Pull/Push/Refresh/Commit
 * 等操作的进度条、git 明细、耗时与取消按钮。由 S.activeOps 驱动（单仓库串行，
 * 同一时刻至多一个操作，显示最新一个）；完成绿色闪现后收起。
 */
import { S, type App } from '../state';
import { el } from '../util';

export interface OpStatus {
  el: HTMLElement;
  /** activeOps 变化（opProgress/opResult 到达）后重渲染 */
  update(): void;
  /** 操作成功完成：绿色闪现约 0.8s（队列中还有后续操作则立即切换） */
  finish(kind: string): void;
}

/** 进度行图标（与工具栏按钮一致） */
const KIND_ICON: Record<string, string> = {
  fetch: '⟳', pull: '⤓', push: '⤒', refresh: '⟲', commit: '✎', commitNoEdit: '✎',
  resolveConflict: '⑂', discard: '⌫', discardClean: '⌫', stage: '＋', unstage: '－',
};
/** 秒级完成、取消无意义的操作 */
const NO_CANCEL = new Set(['refresh', 'stage', 'unstage']);

export function createOpStatus(app: App): OpStatus {
  const root = el('div', 'gg-opstatus off');
  const icon = el('span', 'gg-opstatus-icon');
  const name = el('span', 'gg-opstatus-name');
  const bar = el('div', 'gg-opstatus-bar');
  const fill = el('div', 'gg-opstatus-fill');
  bar.append(fill);
  const pct = el('span', 'gg-opstatus-pct');
  const text = el('span', 'gg-opstatus-text');
  const time = el('span', 'gg-opstatus-time');
  const cancel = el('button', 'gg-opstatus-cancel', '×');
  root.append(icon, name, bar, pct, text, time, cancel);

  let activeOpId: number | undefined;
  let timer: number | undefined;
  let finishTimer: number | undefined;
  let startedAt = 0;

  cancel.addEventListener('click', () => {
    if (activeOpId !== undefined) app.cancelOp(activeOpId);
  });

  function fmtElapsed(ms: number): string {
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
  }

  function stopTimer(): void {
    if (timer !== undefined) { clearInterval(timer); timer = undefined; }
  }

  /** 耗时跳动：进行中每 0.5s 刷新（网络慢/卡住可感知） */
  function startTimer(): void {
    stopTimer();
    timer = window.setInterval(() => {
      if (startedAt) time.textContent = fmtElapsed(Date.now() - startedAt);
    }, 500);
  }

  function update(): void {
    const ops = [...S.activeOps.entries()];
    if (!ops.length) {
      // 无进行中操作且不在完成闪现窗口：收起
      if (finishTimer === undefined) hide();
      return;
    }
    // 新操作开始：取消上一个完成闪现（立即切换）
    if (finishTimer !== undefined) {
      clearTimeout(finishTimer);
      finishTimer = undefined;
    }
    const [opId, op] = ops[ops.length - 1];
    if (opId !== activeOpId) {
      activeOpId = opId;
      startedAt = Date.now();
      startTimer();
    }
    root.classList.remove('off', 'done');
    icon.textContent = KIND_ICON[op.kind] ?? '⏳';
    name.textContent = S.t(op.kind);
    const hasPct = typeof op.pct === 'number' && op.pct >= 0;
    bar.classList.toggle('indet', !hasPct);
    fill.style.width = hasPct ? `${Math.min(100, op.pct!)}%` : '';
    pct.textContent = hasPct ? `${Math.min(100, op.pct!)}%` : '';
    text.textContent = op.text || '';
    text.classList.toggle('empty', !op.text);
    time.textContent = startedAt ? fmtElapsed(Date.now() - startedAt) : '';
    const cancellable = !NO_CANCEL.has(op.kind);
    cancel.classList.toggle('hidden', !cancellable);
    cancel.title = S.t('cancel');
  }

  function finish(kind: string): void {
    root.classList.remove('off');
    root.classList.add('done');
    icon.textContent = '✓';
    name.textContent = S.t(`${kind}Done`);
    pct.textContent = '';
    text.textContent = '';
    bar.classList.remove('indet');
    fill.style.width = '100%';
    time.textContent = startedAt ? fmtElapsed(Date.now() - startedAt) : '';
    cancel.classList.add('hidden');
    stopTimer();
    activeOpId = undefined;
    startedAt = 0;
    // 队列里还有后续操作：opProgress 会立即带来下一个，闪现自然被切换
    if (finishTimer !== undefined) clearTimeout(finishTimer);
    finishTimer = window.setTimeout(() => {
      finishTimer = undefined;
      if (!S.activeOps.size) hide();
    }, 800);
  }

  function hide(): void {
    root.classList.add('off');
    stopTimer();
    activeOpId = undefined;
    startedAt = 0;
  }

  return { el: root, update, finish };
}
