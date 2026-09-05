/**
 * 提交信息栏（设计方案 v1.3 §3.5–3.6）：单一多行输入框（首行=摘要）+
 * AI 生成（空闲/生成中/完成三态，流式填充）+ 提交 ▾ 下拉 + 修订模式。
 */
import { S, type App } from '../state';
import { el, debounce } from '../util';
import { rpc } from '../rpc';
import { showContextMenu, toast, mkBanner } from './overlays';
import { iconSvg } from '../icons';

export interface CommitBar {
  el: HTMLElement;
  update(): void;
  onAiChunk(text: string): void;
  onAiDone(model: string, instructions: number, fallback?: boolean): void;
  onAiError(code: string, message?: string): void;
  focusInput(): void;
  afterCommitOk(shortSha?: string, pushed?: boolean, dirty?: number, subject?: string): void;
  /** 冲突解决+完成合并后的统一推送确认（Issue #7 方案 E） */
  showPushAfterResolve(): void;
  /** 状态刷新联动：工作区已干净或已无待推送（上游存在且领先 0）→ 隐藏推送询问条 */
  autoHidePushq(): void;
  /** 恢复持久化草稿（视图首次打开 / 仓库切换） */
  applyDraft(d: { message: string; pushAfter: boolean; amend: boolean } | null): void;
  /** repoState 到达：amend 基底已被改写（HEAD 前进）→ 自动退出修订模式（Issue #18 B5） */
  checkAmendBase(): void;
}

export function createCommitBar(app: App): CommitBar {
  const root = el('div', 'gg-cbar');

  // 行 1：AI 操作行
  const airow = el('div', 'gg-cbar-row');
  const aiBtn = el('button', 'gg-ai-btn', '✨ AI');
  const modelSel = el('select', 'gg-cbar-select') as HTMLSelectElement;
  const recentBtn = el('button', 'gg-btn small');
  const count = el('span', 'gg-cbar-count');
  airow.append(aiBtn, modelSel, recentBtn, count);

  // 行 2：修订提示条（统一 .gg-banner.warn，Issue #18 S3）
  const amendTip = mkBanner('warn');
  const amendText = el('span');
  const amendExit = el('a', undefined);
  amendExit.href = '#';
  amendTip.title.appendChild(amendText);
  amendTip.acts.appendChild(amendExit);
  amendTip.el.classList.add('hidden');

  // 行 2.5：提交成功推送询问条（统一 .gg-banner.success + sha/主题摘要，Issue #18 S3 决议 5）
  const pushq = mkBanner('success');
  const pushqIc = iconSvg('pushUp');
  pushqIc.classList.add('gg-banner-ic');
  pushq.el.replaceChild(pushqIc, pushq.el.firstChild!);
  const pushqBtn = el('button', 'gg-btn small');
  const pushqSkip = el('button', 'gg-btn small ghost');
  pushq.acts.append(pushqBtn, pushqSkip);
  pushq.el.classList.add('hidden');
  // Issue #7：确认条形态的推送意图已显式（提交后询问/冲突解决收尾）——直接推，
  // 不走 runPush 的落后引导（repoState 刷新竞态下陈旧 behind 会误入"拉取并推送"）
  const pushqDirect = (): void => {
    hidePushq();
    const head = S.state?.branches.find(b => b.isHead);
    const remote = head?.upstream?.split('/')[0] ?? 'origin';
    void rpc('op:push', { remote, branch: S.state?.head.branch }).catch(() => undefined);
  };
  pushqBtn.addEventListener('click', pushqDirect);
  pushqSkip.addEventListener('click', hidePushq);

  // 行 3：唯一的多行提交信息输入框
  const input = el('textarea', 'gg-cbar-input') as HTMLTextAreaElement;
  input.spellcheck = false;

  // 行 4：底行
  const btnrow = el('div', 'gg-cbar-row gg-cbar-bottom');
  const pushChk = el('input') as HTMLInputElement;
  pushChk.type = 'checkbox';
  const pushLabel = el('label', 'gg-cbar-chk');
  pushLabel.append(pushChk, el('span', undefined, ''));
  const commitBtn = el('button', 'gg-btn primary gg-cbar-commit');
  const caretBtn = el('button', 'gg-btn primary gg-cbar-caret', '▾');
  btnrow.append(pushLabel, commitBtn, caretBtn);

  root.append(airow, amendTip.el, pushq.el, input, btnrow);

  function hidePushq(): void {
    pushq.el.classList.add('hidden');
  }

  /** 提交成功：未直接推送 → 显示询问条（开始写下一次信息时自动让位）。
   *  S3 决议 5：标题带 sha、正文带提交主题摘要。 */
  function showPushq(shortSha: string, subject?: string): void {
    pushq.title.textContent = S.t('pushqTitle', { sha: shortSha });
    pushq.body.textContent = subject || S.t('pushqBody');
    pushqBtn.textContent = S.t('pushNow');
    pushqSkip.textContent = S.t('pushSkip');
    pushq.el.classList.remove('hidden');
  }

  /** 冲突解决+完成合并后的统一推送确认（Issue #7 方案 E，对齐 IDEA 显式推送）：
   *  复用询问条形态，一次推完合并提交与此前全部未推提交 */
  function showPushAfterResolve(): void {
    pushq.title.textContent = S.t('pushqResolveText');
    pushq.body.textContent = '';
    pushqBtn.textContent = S.t('pushNow');
    pushqSkip.textContent = S.t('pushSkip');
    pushq.el.classList.remove('hidden');
  }

  // ---------- 草稿持久化（防抖 500ms） ----------
  const saveDraft = debounce(() => {
    void rpc('work.saveDraft', { draft: { message: S.work.message, pushAfter: S.work.pushAfter, amend: S.work.amend } })
      .catch(() => undefined);
  }, 500);

  input.addEventListener('input', () => {
    if (S.work.aiBusy) return;   // 流式期间不做用户输入源
    S.work.message = input.value;
    hidePushq();                 // 开始撰写下一次提交：询问条让位，回到初始状态
    saveDraft();
    refreshCount();
    refreshCommitBtn();
  });
  input.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      doCommit(S.work.amend ? { amend: true } : {});
    }
  });
  pushChk.addEventListener('change', () => {
    S.work.pushAfter = pushChk.checked;
    saveDraft();
  });
  amendExit.addEventListener('click', e => {
    e.preventDefault();
    exitAmend();
  });

  // ---------- AI ----------

  aiBtn.addEventListener('click', () => {
    if (S.work.aiBusy) { app.aiCancel(); return; }
    S.work.aiBusy = true;
    S.work.aiText = '';
    S.work.aiMeta = undefined;
    app.aiGenerate(S.work.aiModelId);
    update();
  });

  modelSel.addEventListener('change', () => {
    S.work.aiModelId = modelSel.value || undefined;   // 会话内记忆，生成时现取
  });

  recentBtn.addEventListener('click', () => {
    void app.workRecentMessages().then(list => {
      if (!list.length) return;
      showContextMenu(
        list.map(m => ({
          label: m.subject.length > 60 ? m.subject.slice(0, 57) + '…' : m.subject,
          run: () => {
            S.work.message = m.subject + (m.body ? `\n\n${m.body}` : '');
            input.value = S.work.message;
            saveDraft();
            refreshCount();
            refreshCommitBtn();
          },
        })),
        recentBtn.getBoundingClientRect().left,
        recentBtn.getBoundingClientRect().top,
      );
    }).catch(() => undefined);
  });

  // ---------- 提交 ----------

  /** A 类状态门控（Issue #18 B1）：冲突未解决 / 合并未完成 → 提交链路预禁用，返回原因 title */
  function blockReason(): string | undefined {
    const st = S.work.state;
    if (!st) return undefined;
    if (st.conflicts.length > 0) return S.t('blockedByConflicts');
    if (st.mergeActive) return S.t('blockedByMerge');
    return undefined;
  }

  /** amend 基底（进入修订时的 HEAD 完整 sha）：HEAD 前进即失效（Issue #18 B5） */
  let amendBaseSha = '';

  commitBtn.addEventListener('click', () => doCommit(S.work.amend ? { amend: true } : {}));
  caretBtn.addEventListener('click', () => {
    const rect = caretBtn.getBoundingClientRect();
    const blocked = blockReason() !== undefined;   // 菜单项同步门控（B1）
    showContextMenu([
      { label: S.t('commitBtn') + '  Ctrl+⏎', run: () => doCommit({}), disabled: blocked },
      { label: S.t('commitAndPush'), run: () => doCommit({ push: true }), disabled: blocked },
      { sep: true },
      { label: `${S.t('amend')}…`, run: () => enterAmend(), disabled: blocked },
      { label: S.t('commitAll'), run: () => doCommit({ all: true, push: S.work.pushAfter }), disabled: blocked },
    ], rect.right - 160, rect.bottom + 4);
  });

  async function doCommit(opts: { push?: boolean; amend?: boolean; all?: boolean }): Promise<void> {
    const message = input.value;
    if ((S.work.state?.conflicts.length ?? 0) > 0) {
      // R3：冲突阻塞提交 → 引导而非报错——切工作副本并弹出合并器（场景 C）
      app.setView('work');
      toastWarn(S.t('conflictBlock'));
      app.openMerge();
      return;
    }
    if (!message.split('\n')[0].trim()) {
      toastWarn(S.t('needMessage'));
      input.focus();
      return;
    }
    const hasStaged = (S.work.state?.staged.length ?? 0) > 0;
    if (!opts.amend && !opts.all && !hasStaged) {
      toastWarn(S.t('needStage'));
      return;
    }
    commitBtn.disabled = true;
    caretBtn.disabled = true;
    const pushed = opts.push ?? S.work.pushAfter;   // 勾选「提交后推送」/下拉「提交并推送」= 直接推不询问
    const subject = message.split('\n')[0].trim();   // 推送询问条摘要（S3 决议 5）
    try {
      const r = await app.workCommit({ message, push: pushed, amend: opts.amend, all: opts.all });
      if (r?.ok) afterCommitOk(r.shortSha, pushed, r.dirty, subject);
    } catch {
      /* 失败信息经 opResult 事件展示 */
    } finally {
      commitBtn.disabled = false;
      caretBtn.disabled = false;
      refreshCommitBtn();
    }
  }

  function toastWarn(msg: string): void {
    toast('warn', msg);
  }

  function enterAmend(): void {
    void app.workAmendLoad().then(head => {
      if (!head) return;
      S.work.amend = true;
      S.work.amendSha = head.shortSha;
      amendBaseSha = S.state?.head?.sha ?? '';   // 记录基底：HEAD 前进即失效（B5）
      S.work.message = head.message;
      input.value = head.message;
      saveDraft();
      update();
      input.focus();
    }).catch(() => undefined);
  }

  function exitAmend(): void {
    S.work.amend = false;
    S.work.amendSha = '';
    amendBaseSha = '';
    S.work.message = '';
    input.value = '';
    saveDraft();
    update();
  }

  /** repoState 到达校验（Issue #18 B5）：amend 期间 HEAD 前进（拉取/外部提交）→ 修订基底失效，自动退出 */
  function checkAmendBase(): void {
    if (!S.work.amend || !amendBaseSha) return;
    const head = S.state?.head?.sha;
    if (head && head !== amendBaseSha) {
      exitAmend();
      toast('warn', S.t('amendHeadMoved'));
    }
  }

  /**
   * 提交成功：清场回初始状态；未直接推送时显示推送询问条。
   * dirty=提交后脏文件数（宿主随响应返回）：工作区已干净时不再显示——
   * 干净空态自带「拉取/推送」按钮，绿色询问条与之叠加即冗余双入口。
   */
  function afterCommitOk(shortSha?: string, pushed = false, dirty?: number, subject?: string): void {
    if (S.config.commitClearMessage) {
      S.work.message = '';
      input.value = '';
    }
    if (S.work.amend) {
      S.work.amend = false;
      S.work.amendSha = '';
      amendBaseSha = '';
    }
    S.work.aiMeta = undefined;
    hidePushq();
    if (!pushed && shortSha && dirty !== 0) showPushq(shortSha, subject);
    saveDraft();
    update();
  }

  /** 状态刷新联动：工作区干净或已无待推送（有上游且领先 0，如已从其他入口推送）→ 询问条让位 */
  function autoHidePushq(): void {
    if (pushq.el.classList.contains('hidden')) return;
    const dirty = S.work.state?.dirtyCount ?? S.state?.status.dirtyCount ?? 0;
    const head = S.state?.branches.find(b => b.isHead);
    const nothingToPush = !!head?.upstream && head.ahead === 0;
    if (dirty === 0 || nothingToPush) hidePushq();
  }

  // ---------- 刷新 ----------

  function refreshCount(): void {
    const first = input.value.split('\n')[0] ?? '';
    count.textContent = first ? `${first.length} / 50` : '';
    count.classList.toggle('warn', first.length > 50);
  }

  function refreshCommitBtn(): void {
    // B1（Issue #18）：状态门控优先于常规可用性——冲突/未完成合并期间预禁用并给原因；
    // doCommit 内的引导兜底保留（防状态刷新竞态）
    const reason = blockReason();
    const hasMsg = !!input.value.split('\n')[0].trim();
    const hasStaged = S.work.amend || (S.work.state?.staged.length ?? 0) > 0;
    const can = hasMsg && hasStaged;
    commitBtn.disabled = reason !== undefined || !can;
    caretBtn.disabled = reason !== undefined;
    commitBtn.title = reason ?? (can ? 'Ctrl+Enter' : !hasMsg ? S.t('needMessage') : S.t('needStage'));
  }

  function update(): void {
    const w = S.work;
    aiBtn.textContent = w.aiBusy ? `◉ ${S.t('aiGenerating')}…` : (w.aiMeta ? `↻ ${S.t('aiRegenerate')}` : `✨ ${S.t('aiGenerate')}`);
    aiBtn.classList.toggle('busy', w.aiBusy);
    // B1（Issue #18）：冲突/未完成合并期间禁用 AI 生成（上下文含冲突标记无意义），title 给原因
    const blocked = blockReason();
    aiBtn.disabled = blocked !== undefined && !w.aiBusy;
    aiBtn.title = w.aiBusy ? S.t('aiStop')
      : blocked ?? (w.state?.staged.length ? S.t('aiGenerateTitle') : S.t('aiGenerateAll'));
    if (w.aiBusy) input.readOnly = true; else input.readOnly = false;

    // 模型下拉
    modelSel.classList.toggle('hidden', !w.aiModels.length);
    if (w.aiModels.length) {
      modelSel.textContent = '';
      for (const m of w.aiModels) {
        const o = el('option', undefined, m.name) as HTMLOptionElement;
        o.value = m.id;
        o.selected = m.id === (w.aiModelId ?? w.aiModels.find(x => x.isDefault)?.id ?? w.aiModels[0].id);
        modelSel.appendChild(o);
      }
    }
    if (!w.aiModelId && w.aiModels.length) {
      w.aiModelId = w.aiModels.find(x => x.isDefault)?.id ?? w.aiModels[0].id;
    }

    recentBtn.textContent = `🕘 ${S.t('recentMsg')}`;
    input.placeholder = S.t('commitPlaceholder');
    pushLabel.querySelector('span')!.textContent = S.t('pushAfter');
    pushChk.checked = w.pushAfter;

    // 修订模式
    amendTip.el.classList.toggle('hidden', !w.amend);
    amendText.textContent = w.amend ? S.t('amendTip', { sha: w.amendSha || '?' }) : '';
    amendExit.textContent = S.t('amendExit');
    commitBtn.textContent = w.amend ? `${S.t('amendCommit')} ⏎` : `${S.t('commitBtn')} ⏎`;
    refreshCommitBtn();
    if (w.aiMeta) {
      // meta 行借用计数位展示（极简）
      count.title = w.aiMeta;
    }
    refreshCount();
  }

  // AI 流式：填充输入框（只追加，完成后用户可编辑）
  function onAiChunk(text: string): void {
    S.work.aiText += text;
    input.value = S.work.aiText;
    input.scrollTop = input.scrollHeight;
    refreshCount();
  }

  function onAiDone(model: string, instructions: number, fallback?: boolean): void {
    S.work.aiBusy = false;
    S.work.message = input.value = S.work.aiText.trim();
    S.work.aiMeta = instructions > 0
      ? S.t('aiDoneWithInstructions', { n: instructions, model })
      : S.t('aiDone', { model });
    if (fallback) S.work.aiMeta += ` · ${S.t('aiFallbackNote')}`;   // 如实标注：差异过大，走的是路径级推断
    count.title = S.work.aiMeta;
    update();
    input.focus();
    const pos = input.value.length;
    input.setSelectionRange(pos, pos);
    saveDraft();
  }

  function onAiError(code: string, message?: string): void {
    S.work.aiBusy = false;
    const key = code === 'noModel' ? 'aiNoModel'
      : code === 'auth' ? 'aiAuth'
        : code === 'quota' ? 'aiQuota'
          : code === 'canceled' ? 'aiCancelled' : 'aiFailed';
    S.work.aiMeta = S.t(key) + (message ? `：${message}` : '');
    count.title = S.work.aiMeta;
    toastWarn(S.work.aiMeta);
    update();
  }

  function focusInput(): void { input.focus(); }

  function applyDraft(d: { message: string; pushAfter: boolean; amend: boolean } | null): void {
    if (S.work.aiBusy) return;
    S.work.message = d?.message ?? '';
    S.work.pushAfter = d?.pushAfter ?? S.config.commitPushAfter;
    S.work.amend = !!d?.amend;
    input.value = S.work.message;
    update();
  }

  // 初始草稿恢复（由 main.ts 在 work.loadDraft 后调用 applyDraft）
  update();
  return { el: root, update, onAiChunk, onAiDone, onAiError, focusInput, afterCommitOk, showPushAfterResolve, autoHidePushq, applyDraft, checkAmendBase };
}
