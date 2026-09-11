/**
 * AI 错误诊断模态与一键修复（Issue #8；#37 增强）：
 * P1 诊断——流式渲染三段式分析（diagChunk/diagDone/diagError 驱动）；
 * P2 修复——宿主已校验的步骤渲染为可执行行（#37 三要素：命令+作用+后果），
 * run 级直跑、confirm 级逐条 S6 危险确认（含 AI 后果说明）、copy 级仅复制；
 * 任一步失败自动以新错误重新诊断（#37：不限轮，模态关闭即终止）。
 */
import type { FixStepDto, OpResult } from '../../common/protocol';
import { rpc } from '../rpc';
import { S } from '../state';
import { el } from '../util';
import { iconSvg } from '../icons';
import { notify, openModal } from './overlays';

export interface DiagnosePayload {
  kind: string;
  command?: string;
  exitCode?: number;
  message?: string;
  outputTail?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
}

/** 由失败 opResult 组装诊断上下文（仓库状态取前端现有数据，宿主零额外 git 调用） */
export function buildDiagPayload(m: Pick<OpResult, 'kind' | 'command' | 'exitCode' | 'message' | 'outputTail'>): DiagnosePayload {
  const head = S.state?.branches.find(b => b.isHead);
  return {
    kind: m.kind,
    command: m.command,
    exitCode: m.exitCode,
    message: m.message,
    outputTail: m.outputTail,
    branch: head?.name ?? S.state?.head.branch,
    upstream: head?.upstream,
    ahead: head?.ahead,
    behind: head?.behind,
  };
}

type DiagErrCode = 'noModel' | 'auth' | 'quota' | 'canceled' | 'error';

let session: DiagnoseSession | undefined;

/**
 * S6 危险确认（图标 + 命令行 + 不可撤销红副行，同 reset hard 警示配方）：
 * confirm 级修复步骤执行前逐条弹 出；「一键执行」不豁免确认。
 * #37：附该步骤的 AI 作用/后果说明（标注 AI 生成，仅辅助人审）。
 * B4 首点即禁用防双击重复触发。
 */
function dangerConfirm(title: string, cmd: string, info?: { action?: string; consequence?: string }): Promise<boolean> {
  return new Promise(resolve => {
    const { box, body, close } = openModal(S.t('fixConfirmTitle', { title }));
    const overlay = box.parentElement as HTMLElement;
    overlay.classList.add('deep');
    const head = el('div', 'gg-dc-head');
    head.appendChild(iconSvg('warnTriangle'));
    const cmdLine = el('span', undefined);
    cmdLine.append(
      el('span', 'gg-dc-pre', S.t('fixConfirmCmd')),
      el('code', 'gg-dc-cmd', cmd),
    );
    head.appendChild(cmdLine);
    const irrev = el('div', 'gg-dc-irrev');
    irrev.appendChild(iconSvg('errorX'));
    irrev.appendChild(el('span', undefined, S.t('fixConfirmText')));
    body.append(head, irrev);
    if (info?.action || info?.consequence) {
      const ai = el('div', 'gg-dc-ai');
      if (info.action) ai.appendChild(el('div', 'gg-dc-ai-row', `${S.t('fixActionLabel')}：${info.action}`));
      if (info.consequence) ai.appendChild(el('div', 'gg-dc-ai-row warn', `${S.t('fixConsequenceLabel')}：${info.consequence}`));
      ai.appendChild(el('div', 'gg-dc-ai-src', S.t('fixFromAi')));
      body.appendChild(ai);
    }
    const btns = el('div', 'gg-modal-btns');
    const cancel = el('button', 'gg-btn', S.t('cancel'));
    const ok = el('button', 'gg-btn danger', S.t('fixRunStep'));
    const done = (v: boolean): void => { close(); resolve(v); };
    cancel.addEventListener('click', () => { ok.disabled = true; cancel.disabled = true; done(false); });
    ok.addEventListener('click', () => { ok.disabled = true; cancel.disabled = true; done(true); });
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(false); });
    box.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
    btns.append(cancel, ok);
    box.appendChild(btns);
    ok.focus();
  });
}

/** 打开诊断模态并发起请求；已有会话则先取消关闭（单会话）。
 *  round（#37）：自动闭环的轮次（>1 时标题旁显示「第 N 轮」） */
export function startDiagnosis(payload: DiagnosePayload, opts?: { retry?: () => void; round?: number }): void {
  session?.destroy();
  session = new DiagnoseSession(payload, opts?.retry, opts?.round ?? 1);
}

export function diagOnChunk(text: string): void { session?.onChunk(text); }
export function diagOnDone(model: string, steps?: FixStepDto[]): void { session?.onDone(model, steps); }
export function diagOnError(code: DiagErrCode, message?: string): void { session?.onError(code, message); }
/** 修复步骤执行失败时登记最新错误（重新诊断的上下文来源） */
export function diagNoteFailure(m: OpResult): void { session?.noteFailure(m); }
export function diagActive(): boolean { return !!session; }
/** Esc：流式生成中取消（与提交信息生成的 Esc 行为对齐） */
export function diagCancelStreaming(): void { session?.cancelStreaming(); }

const ERR_KEY: Record<DiagErrCode, string> = {
  noModel: 'aiNoModel', auth: 'aiAuth', quota: 'aiQuota', canceled: 'aiCancelled', error: 'aiFailed',
};

class DiagnoseSession {
  private readonly overlay: HTMLElement;
  private readonly box: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly foot: HTMLElement;
  private readonly rows = new Map<number, { row: HTMLElement; state: HTMLElement }>();
  private text = '';
  private state: 'streaming' | 'done' | 'error' = 'streaming';
  private steps: FixStepDto[] = [];
  private running = false;
  private destroyed = false;
  /** 「重新诊断」上下文：修复步骤失败时由 opResult 登记的更新错误；缺省回退原始错误 */
  private lastErr: DiagnosePayload;

  constructor(private readonly payload: DiagnosePayload, private readonly retry?: () => void, private readonly round = 1) {
    this.lastErr = payload;
    const title = round > 1
      ? `${S.t('diagTitle', { op: S.t(payload.kind) || payload.kind })} · ${S.t('diagRound', { n: String(round) })}`
      : S.t('diagTitle', { op: S.t(payload.kind) || payload.kind });
    const { box, body, close } = openModal(title);
    this.box = box;
    box.classList.add('gg-diag');
    this.overlay = box.parentElement as HTMLElement;
    // 覆盖层点击关闭 = 会话销毁（须取消宿主流式请求，openModal 自带的 remove 不够）
    this.overlay.addEventListener('mousedown', e => { if (e.target === this.overlay) { close(); this.destroy(); } });
    this.sub = el('div', 'gg-diag-sub');
    const bits: string[] = [];
    if (payload.command) bits.push(payload.command);
    if (typeof payload.exitCode === 'number') bits.push(S.t('diagExit', { n: payload.exitCode }));
    this.sub.textContent = bits.join(' · ');
    const bodyInner = el('div', 'gg-diag-body');
    this.textEl = el('div', 'gg-diag-text');
    bodyInner.append(this.sub, this.textEl);
    body.appendChild(bodyInner);
    this.foot = el('div', 'gg-diag-foot');
    box.appendChild(this.foot);
    this.renderFootStreaming();
    // 长流式请求：结果走事件；RPC 超时（>120s）不算错误（与 aiGenerate 同策略）
    void rpc('err.aiDiagnose', payload as unknown as Record<string, unknown>)
      .catch(e => { if (!/timeout/i.test(String((e as Error)?.message))) this.onError('error', String((e as Error)?.message ?? e)); });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.state === 'streaming') {
      void rpc('err.aiDiagnoseCancel').catch(() => undefined);
    }
    this.overlay.remove();
    if (session === this) session = undefined;
  }

  cancelStreaming(): void {
    if (this.state === 'streaming') this.destroy();
  }

  onChunk(text: string): void {
    if (this.destroyed || this.state !== 'streaming') return;
    this.text += text;
    this.renderText();
    this.autoScroll();
  }

  /** 流式文本渲染：'## 标题' 行升级为小节标题（模型契约的三段式），其余原样 pre-wrap */
  private renderText(): void {
    this.textEl.textContent = '';
    for (const line of this.text.split('\n')) {
      const h = line.match(/^##\s+(.*)$/);
      if (h) {
        if (this.textEl.childNodes.length) this.textEl.appendChild(el('div', 'gg-diag-gap'));
        this.textEl.appendChild(el('div', 'gg-diag-h', h[1]));
      } else {
        const p = el('div', 'gg-diag-p', line);
        if (!line) p.classList.add('empty');
        this.textEl.appendChild(p);
      }
    }
  }

  onDone(model: string, steps?: FixStepDto[]): void {
    if (this.destroyed || this.state !== 'streaming') return;
    this.state = 'done';
    if (model) this.sub.textContent = `${this.sub.textContent} · ${model}`.replace(/^ · /, '');
    this.steps = steps ?? [];
    if (this.steps.length) this.renderFixArea();
    this.renderFootDone();
  }

  onError(code: DiagErrCode, message?: string): void {
    if (this.destroyed || this.state !== 'streaming') return;
    this.state = 'error';
    this.textEl.appendChild(el('div', 'gg-diag-err', S.t(ERR_KEY[code]) + (code === 'error' && message ? `：${message.slice(0, 200)}` : '')));
    this.renderFootDone();
  }

  /** 修复步骤失败时登记（opResult 通道）：供「重新诊断」携带最新错误形成闭环 */
  noteFailure(m: OpResult): void {
    if (!this.steps.length) return;   // 非修复序列引发的失败不打扰原会话
    this.lastErr = buildDiagPayload(m);
  }

  // ---------- 渲染 ----------

  private renderFootStreaming(): void {
    this.foot.textContent = '';
    const stop = el('button', 'gg-btn', S.t('diagStop'));
    stop.addEventListener('click', () => this.destroy());
    this.foot.appendChild(stop);
  }

  private renderFootDone(): void {
    this.foot.textContent = '';
    const runnable = this.steps.filter(s => s.level !== 'copy');
    if (runnable.length && !this.destroyed) {
      const nConfirm = runnable.filter(s => s.level === 'confirm').length;
      const runAll = el('button', 'gg-btn primary', S.t('fixRunAll', { n: runnable.length }));
      if (nConfirm) runAll.title = S.t('fixNeedConfirm', { n: nConfirm });
      runAll.addEventListener('click', () => void this.runSequence(runnable));
      this.foot.appendChild(runAll);
      const copyAll = el('button', 'gg-btn', S.t('fixCopyAll'));
      copyAll.addEventListener('click', () => this.copy(this.steps.map(s => s.cmd).join('\n')));
      this.foot.appendChild(copyAll);
    }
    const copyDiag = el('button', 'gg-btn', S.t('diagCopy'));
    copyDiag.addEventListener('click', () => this.copy(this.text));
    this.foot.appendChild(copyDiag);
    if (this.retry) {
      const retry = el('button', 'gg-btn', S.t('diagRetryOp'));
      retry.addEventListener('click', () => { this.destroy(); this.retry!(); });
      this.foot.appendChild(retry);
    }
  }

  private renderFixArea(): void {
    const fix = el('div', 'gg-fix');
    const head = el('div', 'gg-fix-head');
    const tt = el('span', 'gg-fix-title', S.t('fixSection'));
    const verified = el('span', 'gg-fix-verified', S.t('fixVerified'));
    const nConfirm = this.steps.filter(s => s.level === 'confirm').length;
    if (nConfirm) {
      const chip = el('span', 'gg-fix-chip', S.t('fixNeedConfirm', { n: nConfirm }));
      head.append(tt, verified, chip);
    } else {
      head.append(tt, verified);
    }
    fix.appendChild(head);
    for (const st of this.steps) {
      const row = el('div', `gg-fix-step lv-${st.level}`);
      const num = el('span', 'gg-fix-num', String(st.index));
      const title = el('span', 'gg-fix-st', st.title);
      title.title = st.cmd;
      const cmd = el('code', 'gg-fix-cmd', st.cmd);
      const badge = el('span', `gg-fix-badge ${st.level}`, S.t(`fixLevel${st.level[0].toUpperCase()}${st.level.slice(1)}`));
      const state = el('span', 'gg-fix-state');
      const act = el('button', 'gg-btn small');
      if (st.level === 'copy') {
        act.title = S.t('fixLevelCopy');
        act.appendChild(iconSvg('copy'));
        act.addEventListener('click', () => this.copy(st.cmd));
      } else {
        act.title = S.t(st.level === 'run' ? 'fixLevelRun' : 'fixLevelConfirm');
        act.appendChild(iconSvg('playTriangle'));
        act.addEventListener('click', () => void this.runSequence([st]));
      }
      row.append(num, title, cmd, badge, state, act);
      // #37 三要素：作用（灰）与后果（confirm/copy 级醒目）——AI 生成仅展示
      if (st.action || st.consequence) {
        const info = el('div', 'gg-fix-info');
        if (st.action) info.appendChild(el('div', 'gg-fix-action', `${S.t('fixActionLabel')}：${st.action}`));
        if (st.consequence) {
          const c = el('div', 'gg-fix-cons', `${S.t('fixConsequenceLabel')}：${st.consequence}`);
          if (st.level !== 'run') c.classList.add('warn');
          info.appendChild(c);
        }
        info.appendChild(el('div', 'gg-fix-src', S.t('fixFromAi')));
        row.appendChild(info);
      }
      this.rows.set(st.index, { row, state });
      fix.appendChild(row);
    }
    this.textEl.after(fix);
  }

  // ---------- 执行序列 ----------

  /** 顺序驱动：confirm 级先 S6 确认；任一步失败/取消即停；B4 首点禁用防重入。
   *  #37 自动闭环：失败（非用户取消）时自动以最新错误发起下一轮重新诊断——
   *  轮数不设上限；短暂延迟后销毁当前会话开新轮（模态关闭即终止循环）。 */
  private async runSequence(steps: FixStepDto[]): Promise<void> {
    if (this.running || this.destroyed) return;
    this.running = true;
    for (const b of [...this.foot.querySelectorAll('button')]) (b as HTMLButtonElement).disabled = true;
    let stopped: { n: number; reason: string; failed: boolean } | undefined;
    for (const st of steps) {
      if (this.destroyed) { stopped = { n: st.index, reason: S.t('fixStopReasonCancel'), failed: false }; break; }
      const r = await this.execStep(st);
      if (r === 'cancel') { stopped = { n: st.index, reason: S.t('fixStopReasonCancel'), failed: false }; break; }
      if (r === 'fail') { stopped = { n: st.index, reason: S.t('fixStopReasonFail'), failed: true }; break; }
    }
    this.running = false;
    if (this.destroyed) return;
    for (const b of [...this.foot.querySelectorAll('button')]) (b as HTMLButtonElement).disabled = false;
    const fixEl = this.box.querySelector('.gg-fix');
    if (stopped && fixEl) {
      const bar = el('div', 'gg-fix-stopped');
      bar.append(
        iconSvg('errorX'),
        el('span', undefined, S.t('fixStopped', { n: String(stopped.n), reason: stopped.reason })),
      );
      if (stopped.failed) {
        // #37：失败自动进入下一轮（lastErr 已由 noteFailure 登记为最新错误）
        bar.appendChild(el('span', 'gg-fix-next', S.t('fixAutoNext')));
        setTimeout(() => {
          if (this.destroyed) return;   // 用户在延迟窗口内关闭：循环终止
          const e = this.lastErr;
          const r = this.retry;
          const next = this.round + 1;
          this.destroy();
          startDiagnosis(e, { retry: r, round: next });
        }, 1200);
      } else {
        const re = el('button', 'gg-btn small', S.t('fixReDiag'));
        re.addEventListener('click', () => { const e = this.lastErr; const r = this.retry; this.destroy(); startDiagnosis(e, { retry: r }); });
        bar.appendChild(re);
      }
      fixEl.appendChild(bar);
    } else if (!stopped && fixEl) {
      fixEl.appendChild(el('div', 'gg-fix-allok', S.t('fixAllDone')));
    }
  }

  /** 单步执行：confirm → S6 危险确认（图标+命令+不可撤销副行+#37 AI 作用/后果）；rpc 宿主重校验并走 op 队列 */
  private async execStep(st: FixStepDto): Promise<'ok' | 'fail' | 'cancel'> {
    if (st.level === 'confirm') {
      const ok = await dangerConfirm(st.title, st.cmd, { action: st.action, consequence: st.consequence });
      if (!ok) return 'cancel';
    }
    const entry = this.rows.get(st.index);
    if (entry) entry.state.appendChild(el('span', 'gg-fix-spin'));
    try {
      const r = await rpc('err.aiFixStep', { index: st.index });
      const ok = !!r?.ok;
      if (entry) {
        entry.state.textContent = '';
        entry.state.appendChild(iconSvg(ok ? 'checkCircle' : 'errorX'));
        entry.row.classList.add(ok ? 'did-ok' : 'did-fail');
      }
      return ok ? 'ok' : 'fail';
    } catch {
      if (entry) {
        entry.state.textContent = '';
        entry.state.appendChild(iconSvg('errorX'));
        entry.row.classList.add('did-fail');
      }
      return 'fail';
    }
  }

  // ---------- 工具 ----------

  private copy(text: string): void {
    void rpc('ui:copy', { text })
      .then(() => notify('info', { title: S.t('diagCopied') }))
      .catch(() => undefined);
  }

  private autoScroll(): void {
    const body = this.box.querySelector('.gg-modal-body') as HTMLElement | null;
    if (!body) return;
    // 仅当用户未向上翻阅时跟随滚动（距底 <60px）
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 60) body.scrollTop = body.scrollHeight;
  }
}
