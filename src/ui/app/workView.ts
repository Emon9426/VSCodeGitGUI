/**
 * 工作副本视图（设计方案 v1.3 §3.2–3.4）：
 * 左：文件状态列表（已暂存/未暂存两组，勾选即暂存，乐观更新）
 * 右：单文件单视图 diff（HEAD↔工作副本完整差异，无页签；未跟踪=全新增）
 */
import type { FileEntry } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren } from '../util';
import { rpc } from '../rpc';
import { renderDiff } from '../diff/render';
import { showContextMenu, confirmDialog } from './overlays';

export interface WorkView {
  el: HTMLElement;
  update(): void;
  updateDiff(): void;
}

export function createWorkView(app: App): WorkView {
  const root = el('div', 'gg-work');

  // ---------- 左：文件状态 ----------
  const files = el('div', 'gg-work-files');
  files.style.width = '272px';
  const fhead = el('div', 'gg-work-fhead');
  const ftitle = el('span', 'gg-work-ftitle');
  const fbtns = el('div', 'gg-work-fbtns');
  const stageAllBtn = el('button', 'gg-icon-btn', '⬇');
  const unstageAllBtn = el('button', 'gg-icon-btn', '⬆');
  const fsearch = el('input', 'gg-work-search') as HTMLInputElement;
  const groups = el('div', 'gg-work-groups');
  const stagedHead = mkGroupHead();
  const stagedBox = el('div', 'gg-work-rows');
  const unstagedHead = mkGroupHead();
  const unstagedBox = el('div', 'gg-work-rows');
  fbtns.append(unstageAllBtn, stageAllBtn);
  fhead.append(ftitle, fbtns);
  groups.append(stagedHead.el, stagedBox, unstagedHead.el, unstagedBox);
  files.append(fhead, fsearch, groups);

  // 分组头（元素只建一次：折叠监听不随 update 累积）
  function mkGroupHead(): { el: HTMLElement; caret: HTMLElement; name: HTMLElement; cnt: HTMLElement; isCollapsed(): boolean } {
    const g = el('div', 'gg-work-group-h');
    const caret = el('span', 'gg-work-caret', '▾');
    const name = el('b');
    const cnt = el('span', 'gg-work-cnt', '0');
    g.append(caret, name, cnt);
    g.addEventListener('click', () => {
      g.classList.toggle('collapsed');
      caret.textContent = g.classList.contains('collapsed') ? '▸' : '▾';
      stagedBox.classList.toggle('hidden', stagedHead.el.classList.contains('collapsed'));
      unstagedBox.classList.toggle('hidden', unstagedHead.el.classList.contains('collapsed'));
    });
    return { el: g, caret, name, cnt, isCollapsed: () => g.classList.contains('collapsed') };
  }

  // 列宽拖拽（200–420，持久化到宿主）
  const resizer = el('div', 'gg-work-resizer');
  resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = files.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const w = Math.max(200, Math.min(420, startW + ev.clientX - startX));
      files.style.width = `${w}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      void rpc('work.saveLayout', { filesW: files.getBoundingClientRect().width }).catch(() => undefined);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  files.appendChild(resizer);

  stageAllBtn.addEventListener('click', () => app.workStageAll());
  unstageAllBtn.addEventListener('click', () => app.workUnstageAll());
  fsearch.addEventListener('input', () => {
    S.work.filter = fsearch.value.trim().toLowerCase();
    update();
  });

  // ---------- 右：单文件 diff ----------
  const diffPane = el('div', 'gg-work-diff');
  const dhead = el('div', 'gg-work-dhead');
  const dpath = el('span', 'gg-work-dpath');
  const dstats = el('span', 'gg-work-dstats');
  const dspace = el('span', 'gg-work-dspacer');
  const prevBtn = el('button', 'gg-icon-btn', '‹');
  const nextBtn = el('button', 'gg-icon-btn', '›');
  const openBtn = el('button', 'gg-icon-btn', '↗');
  const nativeBtn = el('button', 'gg-icon-btn', '⇄');
  const copyBtn = el('button', 'gg-icon-btn', '⧉');
  const revealBtn = el('button', 'gg-icon-btn', '📂');
  const modeBtn = el('button', 'gg-btn small');
  const dbox = el('div', 'gg-work-dbox');
  dhead.append(dpath, dstats, dspace, prevBtn, nextBtn, openBtn, nativeBtn, revealBtn, copyBtn, modeBtn);
  diffPane.append(dhead, dbox);

  let compactDiff = true;
  const refreshDiff = () => {
    modeBtn.textContent = compactDiff ? S.t('diffCompact') : S.t('diffContext');
    modeBtn.title = S.t('diffModeTitle');
    renderDiff(dbox, S.work.diff, S.work.selectedPath, compactDiff, () => {
      if (S.work.selectedPath) app.openWorkDiffEditor(S.work.selectedPath);
    });
  };
  modeBtn.addEventListener('click', () => { compactDiff = !compactDiff; refreshDiff(); });

  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  openBtn.addEventListener('click', () => { if (S.work.selectedPath) app.openFile(S.work.selectedPath); });
  copyBtn.addEventListener('click', () => { if (S.work.selectedPath) app.copy(S.work.selectedPath); });
  revealBtn.addEventListener('click', () => { if (S.work.selectedPath) app.revealInFM(S.work.selectedPath); });
  nativeBtn.addEventListener('click', () => { if (S.work.selectedPath) app.openWorkDiffEditor(S.work.selectedPath); });

  /** ‹ › 在（过滤后的）全部更改文件间逐个切换 */
  function step(dir: 1 | -1): void {
    const list = visibleEntries();
    if (!list.length) return;
    const idx = list.findIndex(e => e.path === S.work.selectedPath);
    selectEntry(list[(idx + dir + list.length) % list.length]);
  }

  function visibleEntries(): FileEntry[] {
    const st = S.work.state;
    if (!st) return [];
    const f = S.work.filter;
    const match = (e: FileEntry) => !f || e.path.toLowerCase().includes(f);
    return [...st.staged, ...st.unstaged].filter(match);
  }

  function selectEntry(e: FileEntry): void {
    S.work.selectedPath = e.path;
    S.work.selectedStaged = !!e.staged;
    S.work.diff = undefined;
    app.requestWorkDiff(e.path);
    update();
  }

  // ---------- 渲染 ----------

  function update(): void {
    const w = S.work;
    const st = w.state;
    ftitle.textContent = S.t('workFiles');
    stageAllBtn.title = S.t('stageAll');
    unstageAllBtn.title = S.t('unstageAll');
    fsearch.placeholder = S.t('filterFiles');
    prevBtn.title = S.t('prevFile');
    nextBtn.title = S.t('nextFile');
    openBtn.title = S.t('openFile');
    nativeBtn.title = S.t('openInDiffEditor');
    copyBtn.title = S.t('copyPath');
    revealBtn.title = S.t('revealInFM');

    if (!st) {
      renderGroup(stagedHead, stagedBox, S.t('workStaged'), [], true);
      renderGroup(unstagedHead, unstagedBox, S.t('workUnstaged'), [], false);
      renderEmptyDiff();
      return;
    }

    const f = w.filter;
    const match = (e: FileEntry) => !f || e.path.toLowerCase().includes(f);
    renderGroup(stagedHead, stagedBox, S.t('workStaged'), st.staged.filter(match), true);
    renderGroup(unstagedHead, unstagedBox, S.t('workUnstaged'), st.unstaged.filter(match), false);

    // 干净的工作副本 → 空状态
    if (!st.staged.length && !st.unstaged.length) {
      dpath.textContent = '';
      dstats.textContent = '';
      clearChildren(dbox);
      const empty = el('div', 'gg-work-clean');
      empty.appendChild(el('div', 'gg-work-clean-icon', '✓'));
      empty.appendChild(el('div', 'gg-work-clean-title', S.t('workClean')));
      if (st.headShortSha) {
        const last = el('div', 'gg-work-clean-last', `${S.t('workLastCommit')} ${st.headShortSha} · ${st.headSubject}`);
        last.title = st.headSubject;
        empty.appendChild(last);
      }
      const btns = el('div', 'gg-work-clean-btns');
      const pull = el('button', 'gg-btn small', `↓ ${S.t('pull')}`);
      const push = el('button', 'gg-btn small', `↑ ${S.t('push')}`);
      pull.addEventListener('click', () => app.runPull());
      push.addEventListener('click', () => app.runPush());
      btns.append(pull, push);
      empty.appendChild(btns);
      dbox.appendChild(empty);
      return;
    }

    // 选中行失效（已提交/丢弃）→ 自动补选第一个可见文件
    if (w.selectedPath && !visibleEntries().some(e => e.path === w.selectedPath)) {
      w.selectedPath = undefined;
      w.diff = undefined;
    }
    if (!w.selectedPath) {
      const first = visibleEntries()[0];
      if (first) { selectEntry(first); return; }
    }
    updateDiff();
  }

  function renderGroup(head: { el: HTMLElement; caret: HTMLElement; name: HTMLElement; cnt: HTMLElement; isCollapsed(): boolean }, box: HTMLElement, label: string, list: FileEntry[], _staged: boolean): void {
    head.name.textContent = label;
    head.cnt.textContent = String(list.length);
    box.classList.toggle('hidden', head.isCollapsed());
    clearChildren(box);
    if (!list.length) {
      box.appendChild(el('div', 'gg-work-rowempty', `— ${S.t('workEmpty')} —`));
      return;
    }
    for (const e of list) box.appendChild(row(e, head === stagedHead));
  }

  function row(e: FileEntry, inStagedGroup: boolean): HTMLElement {
    const r = el('div', 'gg-work-row' + (e.path === S.work.selectedPath ? ' selected' : ''));
    const cb = el('input') as HTMLInputElement;
    cb.type = 'checkbox';
    cb.checked = inStagedGroup;
    cb.title = inStagedGroup ? S.t('unstage') : S.t('stage');
    cb.addEventListener('click', ev => ev.stopPropagation());
    cb.addEventListener('change', () => {
      app.workStage([e.path], cb.checked);   // 乐观勾选，workState 事件到达后重排
    });
    r.appendChild(cb);
    const stLetter = e.untracked ? 'U' : inStagedGroup ? (e.staged ?? 'M') : (e.unstaged ?? 'M');
    r.appendChild(el('span', `gg-st ${stLetter}`, stLetter));
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    const dir = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);
    const pathEl = el('span', 'gg-work-fpath');
    if (e.origPath) {
      pathEl.appendChild(el('span', 'gg-work-fdir', base(e.origPath) + ' → '));
      pathEl.appendChild(el('b', undefined, base(e.path)));
      pathEl.title = `${e.origPath} → ${e.path}`;
    } else {
      if (dir(e.path)) pathEl.appendChild(el('span', 'gg-work-fdir', dir(e.path)));
      pathEl.appendChild(el('b', undefined, base(e.path)));
      pathEl.title = e.path;
    }
    r.appendChild(pathEl);
    const num = el('span', 'gg-work-fnum');
    if (e.untracked) {
      num.appendChild(el('i', undefined, S.t('untrackedLabel')));
    } else if (e.additions !== undefined) {
      num.appendChild(el('b', 'a', `+${e.additions}`));
      num.appendChild(el('b', 'd', `−${e.deletions ?? 0}`));
    }
    r.appendChild(num);

    r.addEventListener('click', () => selectEntry(e));
    r.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      const items: Parameters<typeof showContextMenu>[0] = [
        { label: inStagedGroup ? S.t('unstage') : S.t('stage'), run: () => app.workStage([e.path], !inStagedGroup) },
      ];
      if (!inStagedGroup) {
        items.push({ sep: true }, { label: `${S.t('discard')}…`, danger: true, run: () => askDiscard([e.path]) });
      }
      items.push(
        { sep: true },
        { label: S.t('openFile'), run: () => app.openFile(e.path) },
        { label: S.t('revealInFM'), run: () => app.revealInFM(e.path) },
        { label: S.t('copyPath'), run: () => app.copy(e.path) },
      );
      showContextMenu(items, ev.clientX, ev.clientY);
    });
    return r;
  }

  function askDiscard(paths: string[]): void {
    const n = paths.length;
    void confirmDialog(
      S.t('discardConfirmTitle', { n }),
      S.t('discardConfirmText', { n }) + '\n\n' + paths.slice(0, 8).join('\n') + (n > 8 ? `\n…(+${n - 8})` : ''),
      S.t('discard'),
      true,
    ).then(ok => { if (ok) app.workDiscard(paths); });
  }

  function updateDiff(): void {
    const w = S.work;
    const sel = [...(S.work.state?.staged ?? []), ...(S.work.state?.unstaged ?? [])].find(e => e.path === w.selectedPath);
    dpath.textContent = w.selectedPath ?? '';
    dpath.title = w.selectedPath ?? '';
    if (sel?.untracked) {
      dstats.textContent = S.t('untrackedLabel');
    } else if (sel && sel.additions !== undefined) {
      dstats.textContent = `+${sel.additions} −${sel.deletions ?? 0}`;
    } else {
      dstats.textContent = '';
    }
    if (!w.selectedPath) { renderEmptyDiff(); return; }
    if (w.diffLoading === w.selectedPath) {
      clearChildren(dbox);
      dbox.appendChild(el('div', 'gg-diff-note', S.t('loading')));
      return;
    }
    refreshDiff();
  }

  function renderEmptyDiff(): void {
    dpath.textContent = '';
    dstats.textContent = '';
    clearChildren(dbox);
    dbox.appendChild(el('div', 'gg-diff-note', S.t('workSelectFile')));
  }

  root.append(files, diffPane);
  return { el: root, update, updateDiff };
}
