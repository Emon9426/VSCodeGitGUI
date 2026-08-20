/**
 * 提交信息栏（设计方案 v1.3 §3.5–3.6）：单一多行输入框（首行=摘要）+
 * AI 生成（空闲/生成中/完成三态，流式填充）+ 提交 ▾ 下拉 + 修订模式。
 */
import { S, type App } from '../state';
import { el, debounce } from '../util';
import { rpc } from '../rpc';
import { showContextMenu, toast } from './overlays';

export interface CommitBar {
  el: HTMLElement;
  update(): void;
  onAiChunk(text: string): void;
  onAiDone(model: string, instructions: number): void;
  onAiError(code: string, message?: string): void;
  focusInput(): void;
  afterCommitOk(): void;
  /** 恢复持久化草稿（视图首次打开 / 仓库切换） */
  applyDraft(d: { message: string; pushAfter: boolean; amend: boolean } | null): void;
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

  // 行 2：修订提示条（默认隐藏）
  const amendTip = el('div', 'gg-cbar-amend hidden');
  const amendText = el('span');
  const amendExit = el('a', undefined);
  amendExit.href = '#';
  amendTip.append(amendText, amendExit);

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

  root.append(airow, amendTip, input, btnrow);

  // ---------- 草稿持久化（防抖 500ms） ----------
  const saveDraft = debounce(() => {
    void rpc('work.saveDraft', { draft: { message: S.work.message, pushAfter: S.work.pushAfter, amend: S.work.amend } })
      .catch(() => undefined);
  }, 500);

  input.addEventListener('input', () => {
    if (S.work.aiBusy) return;   // 流式期间不做用户输入源
    S.work.message = input.value;
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

  commitBtn.addEventListener('click', () => doCommit(S.work.amend ? { amend: true } : {}));
  caretBtn.addEventListener('click', () => {
    const rect = caretBtn.getBoundingClientRect();
    showContextMenu([
      { label: S.t('commitBtn') + '  Ctrl+⏎', run: () => doCommit({}) },
      { label: S.t('commitAndPush'), run: () => doCommit({ push: true }) },
      { sep: true },
      { label: `${S.t('amend')}…`, run: () => enterAmend() },
      { label: S.t('commitAll'), run: () => doCommit({ all: true, push: S.work.pushAfter }) },
    ], rect.right - 160, rect.bottom + 4);
  });

  async function doCommit(opts: { push?: boolean; amend?: boolean; all?: boolean }): Promise<void> {
    const message = input.value;
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
    try {
      const r = await app.workCommit({ message, push: opts.push ?? S.work.pushAfter, amend: opts.amend, all: opts.all });
      if (r?.ok) afterCommitOk();
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
    S.work.message = '';
    input.value = '';
    saveDraft();
    update();
  }

  function afterCommitOk(): void {
    if (S.config.commitClearMessage) {
      S.work.message = '';
      input.value = '';
    }
    if (S.work.amend) {
      S.work.amend = false;
      S.work.amendSha = '';
    }
    S.work.aiMeta = undefined;
    saveDraft();
    update();
  }

  // ---------- 刷新 ----------

  function refreshCount(): void {
    const first = input.value.split('\n')[0] ?? '';
    count.textContent = first ? `${first.length} / 50` : '';
    count.classList.toggle('warn', first.length > 50);
  }

  function refreshCommitBtn(): void {
    const can = !!input.value.split('\n')[0].trim()
      && (S.work.amend || (S.work.state?.staged.length ?? 0) > 0);
    commitBtn.disabled = !can && !S.work.amend;
    commitBtn.title = can ? 'Ctrl+Enter' : S.t('needStage');
  }

  function update(): void {
    const w = S.work;
    aiBtn.textContent = w.aiBusy ? `◉ ${S.t('aiGenerating')}…` : (w.aiMeta ? `↻ ${S.t('aiRegenerate')}` : `✨ ${S.t('aiGenerate')}`);
    aiBtn.classList.toggle('busy', w.aiBusy);
    aiBtn.title = w.aiBusy ? S.t('aiStop') : (w.state?.staged.length ? S.t('aiGenerateTitle') : S.t('aiGenerateAll'));
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
    amendTip.classList.toggle('hidden', !w.amend);
    amendText.textContent = w.amend ? S.t('amendTip', { sha: w.amendSha || '?' }) : '';
    amendExit.textContent = S.t('amendExit');
    commitBtn.textContent = w.amend ? `${S.t('amendCommit')} ⏎` : `${S.t('commitBtn')} ⏎`;
    if (w.amend) commitBtn.disabled = false;
    else refreshCommitBtn();
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

  function onAiDone(model: string, instructions: number): void {
    S.work.aiBusy = false;
    S.work.message = input.value = S.work.aiText.trim();
    S.work.aiMeta = instructions > 0
      ? S.t('aiDoneWithInstructions', { n: instructions, model })
      : S.t('aiDone', { model });
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
  return { el: root, update, onAiChunk, onAiDone, onAiError, focusInput, afterCommitOk, applyDraft };
}
