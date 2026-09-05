/**
 * 三栏合并解决器（设计方案 v1.3 §4.3）：
 * 我的版本（只读）– 合并版本（最终保存的就是它，块级按钮 + 行内编辑）– 他人版本（只读）。
 * 呈现要点：全程不显示 git 冲突标记；块头就近操作条；来源色条（蓝=我的/绿=他人/灰=手动）；
 * 右缘冲突分布 minimap；三栏百分比同步滚动。
 * 进度落盘：切文件/关闭时自动写回（未解决块重建标记），Webview 回收无损。
 */
import type { MergeSession, MergeSessionAny } from '../../common/models';
import { S } from '../state';
import { el, clearChildren } from '../util';
import { rpc } from '../rpc';
import { confirmDialog, showContextMenu } from './overlays';
import { parseMergeResult, serializeMergeResult, type ConflictChunk, type ParsedMerge } from '../merge/parse';

export interface MergeView {
  el: HTMLElement;
  /** 打开指定冲突文件的合并会话 */
  open(path: string): void;
  /** workState 变化：文件已全部解决时自动流转/收尾 */
  update(): void;
  isOpen(): boolean;
  /** 冲突解决 op 落定（Issue #7）：解除整文件/特殊会话按钮的 pending 态（main.ts opResult 调用） */
  resolveSettled(): void;
}

type ChunkSource = 'mine' | 'theirs' | 'both' | 'none' | 'manual';

interface ChunkState {
  source: ChunkSource;
  lines: string[];
  resolved: boolean;
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function createMergeView(app: { setView(view: 'graph' | 'work'): void }): MergeView {
  const root = el('div', 'gg-merge hidden');

  // ---------- 状态 ----------
  let session: MergeSession | null = null;
  let sessionAny: MergeSessionAny | null = null;
  let parsed: ParsedMerge | null = null;
  const chunkStates = new Map<number, ChunkState>();
  let editingChunk = -1;             // textarea 编辑中的块索引
  let dirty = false;                 // 有已解决块尚未写回
  /** 整文件/特殊会话解决 op 进行中（Issue #7）：按钮禁点防连击，resolveSettled 解除 */
  let pendingResolve = false;

  // ---------- DOM ----------
  const top = el('div', 'gg-merge-top');
  const fileName = el('span', 'gg-merge-fname');
  const fileProg = el('span', 'gg-merge-fprog');
  const prevFile = el('button', 'gg-btn tiny');
  const nextFile = el('button', 'gg-btn tiny');
  const chunkNav = el('span', 'gg-merge-cnav');
  const prevChunk = el('button', 'gg-btn tiny');
  const nextChunk = el('button', 'gg-btn tiny');
  const wholeBtn = el('button', 'gg-btn tiny');
  const vscodeBtn = el('button', 'gg-btn tiny');
  const abortBtn = el('button', 'gg-btn tiny danger');
  const closeBtn = el('button', 'gg-merge-close', '✕');
  top.append(fileName, fileProg, prevFile, nextFile, el('span', 'gg-merge-spacer'), chunkNav, prevChunk, nextChunk, wholeBtn, vscodeBtn, abortBtn, closeBtn);

  const colsWrap = el('div', 'gg-merge-cols');
  const colMine = el('div', 'gg-merge-col mine');
  const colResult = el('div', 'gg-merge-col result');
  const colTheirs = el('div', 'gg-merge-col theirs');
  const headMine = el('div', 'gg-merge-colh');
  const headResult = el('div', 'gg-merge-colh');
  const headTheirs = el('div', 'gg-merge-colh');
  const linesMine = el('div', 'gg-merge-lines');
  const linesResult = el('div', 'gg-merge-lines');
  const linesTheirs = el('div', 'gg-merge-lines');
  headMine.append(el('span', undefined, '⬅ '), el('b'), el('span', 'gg-merge-hint'));
  headResult.append(el('span', undefined, '⬇ '), el('b'), el('span', 'gg-merge-hint'));
  headTheirs.append(el('b'), el('span', undefined, ' ➡'), el('span', 'gg-merge-hint'));
  colMine.append(headMine, linesMine);
  colResult.append(headResult, linesResult);
  colTheirs.append(headTheirs, linesTheirs);

  const map = el('div', 'gg-merge-map');
  colsWrap.append(colMine, colResult, colTheirs, map);

  const foot = el('div', 'gg-merge-foot');
  const footMsg = el('span', 'gg-merge-footmsg');
  const stageHint = el('span', 'gg-merge-stagehint');
  const finishBtn = el('button', 'gg-btn primary');
  foot.append(footMsg, el('span', 'gg-merge-spacer'), stageHint, finishBtn);

  root.append(top, colsWrap, foot);

  // ---------- 会话加载 ----------
  let openSeq = 0;
  async function open(path: string): Promise<void> {
    const seq = ++openSeq;
    await flushPartial();          // 上一个文件的已解决块落盘
    session = null; sessionAny = null; parsed = null;
    chunkStates.clear(); editingChunk = -1; dirty = false;
    renderLoading(path);
    root.classList.remove('hidden');
    if (S.view !== 'work') app.setView('work');
    try {
      const s = await rpc('merge.session', { path }) as MergeSessionAny;
      if (seq !== openSeq) return;   // 已被更新的 open 取代，丢弃过期响应
      sessionAny = s;
      if (s.binary) { session = null; parsed = null; renderSpecial(); return; }
      if ('tooLarge' in s) { session = null; parsed = null; renderSpecial(); return; }
      session = s;
      parsed = parseMergeResult(s.result);
      for (const c of parsed.chunks) chunkStates.set(c.index, { source: 'mine', lines: c.mineLines, resolved: false });
      render();
    } catch (e) {
      if (seq !== openSeq) return;
      renderError(e instanceof Error ? e.message : String(e));
    }
  }

  function close(): void {
    root.classList.add('hidden');
    session = null; sessionAny = null; parsed = null;
    chunkStates.clear(); editingChunk = -1;
  }

  /** 已解决块进度落盘（未解决块重建标记，保持 UU 状态） */
  async function flushPartial(): Promise<void> {
    if (!session || !parsed || !dirty) return;
    const snap = session; const snapParsed = parsed;
    dirty = false;
    try {
      const content = serializeMergeResult(snapParsed, resolvedMap());
      await rpc('merge.save', { path: snap.path, content, stage: false });
    } catch { /* 落盘失败不阻塞切换；重开会话仍能从文件读回已解决部分 */ }
  }

  function resolvedMap(): Map<number, string[]> {
    const m = new Map<number, string[]>();
    for (const [idx, st] of chunkStates) if (st.resolved) m.set(idx, st.lines);
    return m;
  }

  // ---------- 渲染 ----------
  function renderLoading(path: string): void {
    fileName.textContent = path;
    clearChildren(linesMine); clearChildren(linesResult); clearChildren(linesTheirs); clearChildren(map);
    linesResult.appendChild(el('div', 'gg-merge-note', S.t('loading')));
    updateChrome();
  }

  function renderError(msg: string): void {
    clearChildren(linesResult);
    linesResult.appendChild(el('div', 'gg-merge-note err', msg));
    updateChrome();
  }

  function updateChrome(): void {
    const conflicts = S.work.state?.conflicts ?? [];
    const idx = sessionAny ? conflicts.findIndex(c => c.path === (sessionAny as { path: string }).path) : -1;
    fileProg.textContent = idx >= 0 ? S.t('mergeFileProgress', { i: idx + 1, n: conflicts.length }) : '';
    prevFile.textContent = '‹'; nextFile.textContent = '›';
    prevFile.title = S.t('mergePrevFile'); nextFile.title = S.t('mergeNextFile');
    const kind = sessionAny && !('tooLarge' in sessionAny) && sessionAny.kind
      ? S.t(sessionAny.kind === 'rebase' ? 'mergeKindRebase' : sessionAny.kind === 'merge' ? 'mergeKindMerge' : 'mergeKindOther')
      : '';
    fileName.title = kind;
    chunkNav.textContent = kind;
    prevChunk.textContent = S.t('mergePrevChunk');
    nextChunk.textContent = S.t('mergeNextChunk');
    wholeBtn.textContent = S.t('mergeWholeMenu');
    vscodeBtn.textContent = S.t('mergeOpenVscode');
    abortBtn.textContent = S.t('mergeAbortBtn');
    const st = session && parsed ? sessionState() : null;
    headMine.querySelector('b')!.textContent = S.t('mergeColMine');
    (headMine.querySelector('.gg-merge-hint') as HTMLElement).textContent =
      S.t('mergeHintMine', { ref: session ? refText(session.labels.mineRef, session.kind, true) : '' });
    headResult.querySelector('b')!.textContent = S.t('mergeColResult');
    headTheirs.querySelector('b')!.textContent = S.t('mergeColTheirs');
    (headTheirs.querySelector('.gg-merge-hint') as HTMLElement).textContent =
      S.t('mergeHintTheirs', { ref: session ? refText(session.labels.theirsRef, session.kind, false) : '' });
    const done = st ? st.resolved : 0;
    const total = st ? st.total : 0;
    (headResult.querySelector('.gg-merge-hint') as HTMLElement).textContent = S.t('mergeHintResult', { r: done, t: total });
    footMsg.textContent = st ? S.t('mergeFootProgress', { r: done, t: total }) : '';
    stageHint.textContent = st && done < total ? S.t('mergeLegend') : '';
    const allDone = !!st && st.total > 0 && done === st.total;
    finishBtn.disabled = !allDone;
    finishBtn.textContent = S.t('mergeFinishBtn');
  }

  function refText(ref: string, kind: string, mine: boolean): string {
    if (kind === 'merge') return mine ? S.t('mergeRefLocal') : (ref || S.t('mergeRefIncoming'));
    if (kind === 'rebase') return mine ? S.t('mergeRefReplaying') : (ref ? S.t('mergeRefBase', { ref }) : S.t('mergeRefIncoming'));
    return ref || '';
  }

  function sessionState(): { resolved: number; total: number } {
    let resolved = 0, total = 0;
    for (const [, st] of chunkStates) { total++; if (st.resolved) resolved++; }
    return { resolved, total };
  }

  function render(): void {
    if (!session || !parsed) return;
    clearChildren(linesMine); clearChildren(linesResult); clearChildren(linesTheirs);
    let lineNo = 0;
    const chunkStartLines = new Map<number, number>();
    for (const seg of parsed.segs) {
      if (seg.type === 'common') {
        for (const text of seg.lines) {
          lineNo++;
          linesMine.appendChild(commonRow(lineNo, text));
          linesResult.appendChild(commonRow(lineNo, text));
          linesTheirs.appendChild(commonRow(lineNo, text));
        }
        continue;
      }
      const c = seg.chunk;
      chunkStartLines.set(c.index, lineNo + 1);
      // 左右栏：整块高亮 + 块首行 » « 一键采纳
      linesMine.appendChild(sideBlockStart(c, true));
      for (const text of c.mineLines) { lineNo++; linesMine.appendChild(sideRow(lineNo, text, 'ours')); }
      linesTheirs.appendChild(sideBlockStart(c, false));
      // 他人栏行号从块前继续（行数可能不同，顺序展示即可）
      for (const text of c.theirsLines) linesTheirs.appendChild(sideRow(0, text, 'theirs'));
      // 中栏：已解决=绿条+结果行；编辑中=操作条+textarea；未动=操作条+当前结果行（来源色条）
      const st = chunkStates.get(c.index)!;
      if (st.resolved) {
        linesResult.appendChild(resolvedBar(c, st));
        for (const text of st.lines) { lineNo++; linesResult.appendChild(resultRow(lineNo, text, st.source)); }
      } else if (editingChunk === c.index) {
        const wrap = el('div', 'gg-mchunk');
        wrap.appendChild(chunkBar(c));
        wrap.appendChild(editArea(c, st));
        linesResult.appendChild(wrap);
      } else {
        linesResult.appendChild(chunkBar(c));
        for (const text of st.lines) linesResult.appendChild(resultRow(0, text, st.source));
      }
    }
    renderMap(chunkStartLines);
    updateChrome();
  }

  function commonRow(no: number, text: string): HTMLElement {
    const r = el('div', 'gg-ml ctx');
    r.appendChild(el('span', 'gg-ml-no', String(no || '')));
    r.appendChild(el('span', 'gg-ml-tx', text));
    return r;
  }

  function sideRow(no: number, text: string, side: 'ours' | 'theirs'): HTMLElement {
    const r = el('div', 'gg-ml ' + side);
    r.appendChild(el('span', 'gg-ml-no', String(no || '')));
    const tx = el('span', 'gg-ml-tx', text);
    r.appendChild(tx);
    return r;
  }

  /** 左右栏块首行：文本 + 边缘采纳箭头（»/«） */
  function sideBlockStart(c: ConflictChunk, mine: boolean): HTMLElement {
    const r = el('div', 'gg-ml ' + (mine ? 'ours' : 'theirs') + ' first');
    r.appendChild(el('span', 'gg-ml-no', ''));
    const tx = el('span', 'gg-ml-tx', mine ? c.mineLines[0] : c.theirsLines[0]);
    r.appendChild(tx);
    const arr = el('button', 'gg-ml-arr', mine ? '»' : '«');
    arr.title = mine ? S.t('mergeUseMine') : S.t('mergeUseTheirs');
    arr.addEventListener('click', ev => { ev.stopPropagation(); applyChunk(c.index, mine ? 'mine' : 'theirs'); });
    r.appendChild(arr);
    return r;
  }

  function chunkBar(c: ConflictChunk): HTMLElement {
    const bar = el('div', 'gg-mchunk-bar');
    bar.appendChild(el('span', 'gg-mchunk-tag', S.t('mergeChunkTag', { n: c.index + 1 })));
    const mk = (label: string, cls: string, fn: () => void) => {
      const b = el('button', 'gg-mchunk-btn ' + cls, label);
      b.addEventListener('click', ev => { ev.stopPropagation(); fn(); });
      return b;
    };
    bar.appendChild(mk(S.t('mergeUseMine'), 'mine', () => applyChunk(c.index, 'mine')));
    bar.appendChild(mk(S.t('mergeTakeBoth'), 'both', () => applyChunk(c.index, 'both')));
    bar.appendChild(mk(S.t('mergeUseTheirs'), 'theirs', () => applyChunk(c.index, 'theirs')));
    bar.appendChild(mk(S.t('mergeTakeNone'), 'none', () => applyChunk(c.index, 'none')));
    bar.appendChild(el('span', 'gg-merge-spacer'));
    bar.appendChild(mk(S.t('mergeEditBtn'), 'edit', () => { editingChunk = c.index; render(); }));
    return bar;
  }

  function resolvedBar(c: ConflictChunk, st: ChunkState): HTMLElement {
    const bar = el('div', 'gg-mresolved');
    const srcLabel = st.source === 'mine' ? S.t('mergeSrcMine')
      : st.source === 'theirs' ? S.t('mergeSrcTheirs')
        : st.source === 'both' ? S.t('mergeSrcBoth') : S.t('mergeSrcManual');
    bar.appendChild(el('span', undefined, S.t('mergeResolvedBadge', { n: c.index + 1, src: srcLabel })));
    bar.appendChild(el('span', 'gg-merge-spacer'));
    const redo = el('button', 'gg-btn tiny', S.t('mergeRedo'));
    redo.addEventListener('click', ev => {
      ev.stopPropagation();
      const ch = parsed?.chunks[c.index];
      if (!ch) return;
      chunkStates.set(c.index, { source: 'mine', lines: ch.mineLines, resolved: false });
      dirty = true; render();
    });
    bar.appendChild(redo);
    return bar;
  }

  function resultRow(no: number, text: string, source: ChunkSource): HTMLElement {
    const cls = source === 'manual' ? 'manual' : source === 'theirs' ? 'src-t' : source === 'both' ? 'src-b' : source === 'none' ? 'src-n' : 'src-m';
    const r = el('div', 'gg-ml res ' + cls);
    r.appendChild(el('span', 'gg-ml-no', String(no || '')));
    r.appendChild(el('span', 'gg-ml-tx', text));
    return r;
  }

  function editArea(c: ConflictChunk, st: ChunkState): HTMLElement {
    const wrap = el('div', 'gg-medit-wrap');
    const ta = el('textarea', 'gg-medit') as HTMLTextAreaElement;
    ta.value = st.lines.join('\n');
    ta.spellcheck = false;
    const bar = el('div', 'gg-medit-bar');
    const apply = el('button', 'gg-btn tiny primary', S.t('mergeApply'));
    const cancel = el('button', 'gg-btn tiny', S.t('mergeCancelEdit'));
    apply.addEventListener('click', () => {
      const lines = ta.value.split('\n');
      chunkStates.set(c.index, { source: 'manual', lines, resolved: true });
      editingChunk = -1; dirty = true;
      render();
      scrollToChunk(c.index);
    });
    cancel.addEventListener('click', () => { editingChunk = -1; render(); });
    bar.append(cancel, apply);
    wrap.append(ta, bar);
    requestAnimationFrame(() => ta.focus());
    return wrap;
  }

  /** 块操作：mine/theirs/both/none —— resolved=true + 进度落盘标记 */
  function applyChunk(index: number, source: ChunkSource): void {
    const c = parsed?.chunks[index];
    if (!c) return;
    const lines = source === 'mine' ? c.mineLines
      : source === 'theirs' ? c.theirsLines
        : source === 'both' ? [...c.mineLines, ...c.theirsLines]
          : [];
    chunkStates.set(index, { source, lines, resolved: true });
    editingChunk = -1; dirty = true;
    render();
    scrollToChunk(index);
    void autoSaveTimer();
  }

  /** 连续点击块操作时合并落盘（防抖 1.5s） */
  let saveTimer: number | undefined;
  function autoSaveTimer(): Promise<void> {
    if (saveTimer) window.clearTimeout(saveTimer);
    return new Promise(resolve => {
      saveTimer = window.setTimeout(() => { saveTimer = undefined; void flushPartial().then(resolve); }, 1500);
    });
  }

  // ---------- minimap ----------
  function renderMap(chunkStartLines: Map<number, number>): void {
    clearChildren(map);
    if (!parsed) return;
    const total = Math.max(1, linesResult.scrollHeight || 1);
    void total;
    // 用块所在结果行号 / 总行号 定位
    let totalLines = 0;
    for (const seg of parsed.segs) {
      if (seg.type === 'common') totalLines += seg.lines.length;
      else totalLines += (chunkStates.get(seg.chunk.index)?.lines ?? seg.chunk.mineLines).length;
    }
    for (const c of parsed.chunks) {
      const st = chunkStates.get(c.index)!;
      const start = chunkStartLines.get(c.index) ?? 0;
      const dot = el('i', st.resolved ? 'ok' : 'todo');
      dot.style.top = `${Math.min(98, (start / Math.max(1, totalLines)) * 100)}%`;
      dot.title = S.t('mergeChunkTag', { n: c.index + 1 });
      dot.addEventListener('click', () => scrollToChunk(c.index));
      map.appendChild(dot);
    }
  }

  function scrollToChunk(index: number): void {
    const bar = linesResult.querySelectorAll('.gg-mchunk-bar, .gg-mresolved')[index] as HTMLElement | undefined;
    if (bar) bar.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------- 特殊会话：二进制 / 一方删除 / 超限 ----------
  function renderSpecial(): void {
    if (!sessionAny) return;
    clearChildren(linesMine); clearChildren(linesResult); clearChildren(linesTheirs); clearChildren(map);
    const s = sessionAny;
    const box = el('div', 'gg-merge-special');
    const path = s.path;
    if ('tooLarge' in s && s.tooLarge) {
      box.appendChild(el('div', 'gg-merge-special-title', '⚠ ' + S.t('mergeTooLargeTitle')));
      box.appendChild(el('div', 'gg-merge-special-text',
        S.t('mergeTooLargeText', { lines: String(s.lines), size: fmtBytes(s.bytes), limitLines: '16000', limitSize: '2 MB' })));
      const btns = el('div', 'gg-merge-special-btns');
      const mine = el('button', 'gg-btn', S.t('mergeWholeMine'));
      const theirs = el('button', 'gg-btn', S.t('mergeWholeTheirs'));
      const open = el('button', 'gg-btn', S.t('mergeOpenVscode'));
      const stage = el('button', 'gg-btn primary', S.t('mergeStageResolved'));
      mine.addEventListener('click', () => dispatchResolve(() => rpc('merge.resolve', { path, side: 'mine' })));
      theirs.addEventListener('click', () => dispatchResolve(() => rpc('merge.resolve', { path, side: 'theirs' })));
      open.addEventListener('click', () => void rpc('ui:openDiffEditor', { sha: 'HEAD', base: 'HEAD', path, worktree: true }).catch(showErrLocal));
      stage.addEventListener('click', () => { void rpc('work.stage', { paths: [path] }).catch(showErrLocal); close(); });
      if (pendingResolve) { mine.disabled = true; theirs.disabled = true; }
      btns.append(mine, theirs, open, stage);
      box.appendChild(btns);
    } else if ('binary' in s && s.binary) {
      box.appendChild(el('div', 'gg-merge-special-title', S.t('mergeBinaryTitle')));
      box.appendChild(el('div', 'gg-merge-special-text', S.t('mergeBinaryHint')));
      const cards = el('div', 'gg-merge-cards');
      if (s.deletedSide !== 'mine') {
        cards.appendChild(sideCard(S.t('mergeColMine'), s.mineSize, 'mine', path));
      }
      if (s.deletedSide !== 'theirs') {
        cards.appendChild(sideCard(S.t('mergeColTheirs'), s.theirsSize, 'theirs', path));
      }
      if (s.deletedSide) {
        const del = el('button', 'gg-btn danger', S.t('mergeDeletedAccept'));
        del.addEventListener('click', () => dispatchResolve(() => rpc('merge.deleteAccept', { path, side: s.deletedSide === 'mine' ? 'mine' : 'theirs' })));
        if (pendingResolve) del.disabled = true;
        cards.appendChild(el('div', 'gg-merge-card-solo')).appendChild(del);
      }
      box.appendChild(cards);
    } else if ('deletedSide' in s && s.deletedSide) {
      // 文本一方删除：保留现存侧 / 采纳删除
      box.appendChild(el('div', 'gg-merge-special-title', S.t('mergeDeletedTitle')));
      const cards = el('div', 'gg-merge-cards');
      const mineCard = el('div', 'gg-merge-card');
      const keep = s.deletedSide === 'mine'
        ? { side: 'theirs' as const, label: S.t('mergeDeletedKeepTheirs') }
        : { side: 'mine' as const, label: S.t('mergeDeletedKeepMine') };
      mineCard.appendChild(el('div', 'gg-merge-card-t', keep.label));
      const keepBtn = el('button', 'gg-btn primary', keep.label);
      keepBtn.addEventListener('click', () => dispatchResolve(() => rpc('merge.deleteAccept', { path, side: keep.side })));
      const delBtn = el('button', 'gg-btn danger', S.t('mergeDeletedAccept'));
      delBtn.addEventListener('click', () => dispatchResolve(() => rpc('merge.deleteAccept', { path, side: s.deletedSide === 'mine' ? 'mine' : 'theirs' })));
      if (pendingResolve) { keepBtn.disabled = true; delBtn.disabled = true; }
      mineCard.append(keepBtn, delBtn);
      cards.appendChild(mineCard);
      box.appendChild(cards);
    }
    linesResult.appendChild(box);
    updateChrome();
  }

  function sideCard(title: string, size: number | undefined, side: 'mine' | 'theirs', path: string): HTMLElement {
    const card = el('div', 'gg-merge-card');
    card.appendChild(el('div', 'gg-merge-card-t', title));
    card.appendChild(el('div', 'gg-merge-card-m', size !== undefined ? fmtBytes(size) : ''));
    const pick = el('button', 'gg-btn primary', side === 'mine' ? S.t('mergeWholeMine') : S.t('mergeWholeTheirs'));
    pick.addEventListener('click', () => dispatchResolve(() => rpc('merge.resolve', { path, side })));
    const prev = el('button', 'gg-btn', S.t('mergeBinaryPreview'));
    prev.addEventListener('click', () => void rpc('merge.previewBinary', { path, side }).catch(showErrLocal));
    if (pendingResolve) { pick.disabled = true; prev.disabled = true; }
    card.append(pick, prev);
    return card;
  }

  function showErrLocal(e: unknown): void {
    void confirmDialog(S.t('error'), e instanceof Error ? e.message : String(e), S.t('close'));
  }

  /** 整文件/特殊会话解决派发（Issue #7）：置 pending 防连击，RPC 直发错误回显并复位 */
  function dispatchResolve(fn: () => Promise<unknown>): void {
    if (pendingResolve) return;
    pendingResolve = true;
    void fn().catch(e => { pendingResolve = false; showErrLocal(e); renderCurrent(); });
    renderCurrent();
  }

  /** 按当前会话类型重渲染（pending 态变化后刷新按钮禁用） */
  function renderCurrent(): void {
    if (!sessionAny || root.classList.contains('hidden')) return;
    if (!session && sessionAny) renderSpecial();
    else if (session && parsed) render();
  }

  // ---------- 顶部操作 ----------
  function conflictPaths(): string[] {
    return (S.work.state?.conflicts ?? []).map(c => c.path);
  }

  function stepFile(dir: 1 | -1): void {
    const paths = conflictPaths();
    if (!paths.length || !sessionAny) return;
    const cur = paths.indexOf((sessionAny as { path: string }).path);
    const next = paths[(cur + dir + paths.length) % paths.length];
    if (next) void open(next);
  }

  prevFile.addEventListener('click', () => stepFile(-1));
  nextFile.addEventListener('click', () => stepFile(1));
  prevChunk.addEventListener('click', () => navChunk(-1));
  nextChunk.addEventListener('click', () => navChunk(1));

  function navChunk(dir: 1 | -1): void {
    if (!parsed) return;
    const open = [...chunkStates.entries()].filter(([, st]) => !st.resolved).map(([i]) => i).sort((a, b) => a - b);
    if (!open.length) return;
    // 向后取第一个未解决；已到尾则回到首个（循环）
    const cur = open.findIndex(i => i > Math.max(0, editingChunk));
    const target = dir === 1 ? (cur >= 0 ? open[cur] : open[0]) : open[0];
    editingChunk = -1;
    scrollToChunk(target);
  }

  wholeBtn.addEventListener('click', e => {
    if (!sessionAny) return;
    const path = (sessionAny as { path: string }).path;
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    showContextMenu([
      { label: S.t('mergeWholeMine'), run: () => dispatchResolve(() => rpc('merge.resolve', { path, side: 'mine' })) },
      { label: S.t('mergeWholeTheirs'), run: () => dispatchResolve(() => rpc('merge.resolve', { path, side: 'theirs' })) },
    ], rect.left, rect.bottom + 4);
  });

  vscodeBtn.addEventListener('click', () => {
    if (!sessionAny) return;
    void rpc('ui:openDiffEditor', { sha: 'HEAD', base: 'HEAD', path: (sessionAny as { path: string }).path, worktree: true }).catch(showErrLocal);
  });

  abortBtn.addEventListener('click', () => {
    void confirmDialog(S.t('mergeAbortTitle'), S.t('mergeAbortText'), S.t('mergeAbortConfirmBtn'), true).then(ok => {
      if (!ok) return;
      void rpc('merge.abort').then(() => close()).catch(showErrLocal);
    });
  });

  closeBtn.addEventListener('click', () => { void flushPartial().then(() => close()); });

  finishBtn.addEventListener('click', () => {
    if (!session || !parsed) return;
    const st = sessionState();
    if (st.resolved !== st.total || st.total === 0) return;
    const isRebase = session.kind === 'rebase';
    const title = isRebase ? S.t('mergeRebaseFinishTitle') : S.t('mergeFinishTitle');
    const text = isRebase
      ? S.t('mergeRebaseFinishText')
      : S.t('mergeFinishText') + (session.mergeMsg ? `\n\n“${session.mergeMsg}”` : '');
    void confirmDialog(title, text, isRebase ? S.t('mergeRebaseFinishBtn') : S.t('mergeFinishBtn2'), true).then(async ok => {
      if (!ok) return;
      const path = session!.path;
      const content = serializeMergeResult(parsed!, resolvedMap());
      // Issue #7（§8.5 Accept and Finish）：确认后 spinner + 禁点，防连点重复提交
      finishBtn.disabled = true;
      finishBtn.textContent = S.t('workResolving');
      try {
        await rpc('merge.save', { path, content, stage: true });
        if (!isRebase) { close(); return; }
        await rpc('merge.finish');
        close();
      } catch (err) { showErrLocal(err); }
      updateChrome();
    });
  });

  // ---------- 三栏百分比同步滚动（首版近似，公共行锚点对齐后续打磨） ----------
  let syncing = false;
  for (const box of [linesMine, linesResult, linesTheirs]) {
    box.addEventListener('scroll', () => {
      if (syncing) return;
      syncing = true;
      const max = box.scrollHeight - box.clientHeight;
      const pct = max > 0 ? box.scrollTop / max : 0;
      for (const other of [linesMine, linesResult, linesTheirs]) {
        if (other === box) continue;
        const om = other.scrollHeight - other.clientHeight;
        if (om > 0) other.scrollTop = pct * om;
      }
      requestAnimationFrame(() => { syncing = false; });
    });
  }

  // ---------- workState 联动 ----------
  function update(): void {
    if (root.classList.contains('hidden') || !sessionAny) return;
    const path = (sessionAny as { path: string }).path;
    const conflicts = S.work.state?.conflicts ?? [];
    const still = conflicts.some(c => c.path === path);
    if (!still && session && parsed) {
      // 当前文件已解决（外部操作/自动流转）：写回余量后切下一个或收起
      void flushPartial().then(() => {
        const rest = conflictPaths();
        if (rest.length) void open(rest[0]);
        else close();
      });
      return;
    }
    updateChrome();
  }

  /** 冲突解决 op 落定（Issue #7）：解除 pending 态并刷新按钮 */
  function resolveSettled(): void {
    if (!pendingResolve) return;
    pendingResolve = false;
    renderCurrent();
  }

  return { el: root, open, update, isOpen: () => !root.classList.contains('hidden'), resolveSettled };
}
