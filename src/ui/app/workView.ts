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
import { setIcon, type IconName } from '../icons';

export interface WorkView {
  el: HTMLElement;
  update(): void;
  updateDiff(): void;
  /** 恢复持久化的文件列表宽度（ready 时宿主下发，钳制防异常值） */
  applyFilesWidth(w: number): void;
}

export function createWorkView(app: App): WorkView {
  const root = el('div', 'gg-work');
  // 外层：冲突横幅（merging 时常驻）+ 原有 row 布局
  const outer = el('div', 'gg-work-outer');
  const banner = el('div', 'gg-merge-banner hidden');
  const bannerText = el('div', 'gg-merge-banner-t');
  const bannerBtns = el('div', 'gg-merge-banner-btns');
  banner.append(bannerText, bannerBtns);
  outer.append(banner, root);

  // ---------- 左：文件状态 ----------
  const files = el('div', 'gg-work-files');
  files.style.width = '272px';
  const fhead = el('div', 'gg-work-fhead');
  const ftitle = el('span', 'gg-work-ftitle');
  const fbtns = el('div', 'gg-work-fbtns');
  const refreshBtn = el('button', 'gg-icon-btn');
  const cleanTempBtn = el('button', 'gg-icon-btn');  // 一键移除 Office 临时文件（~$ 开头；仅存在时显示）
  const stageAllBtn = el('button', 'gg-icon-btn');
  const unstageAllBtn = el('button', 'gg-icon-btn');   // 清单勾选/空框：与行内"勾选即暂存"直接对应
  setIcon(refreshBtn, 'refresh');
  setIcon(cleanTempBtn, 'broom');
  setIcon(stageAllBtn, 'checklist');
  setIcon(unstageAllBtn, 'checklistEmpty');
  const fsearch = el('input', 'gg-work-search') as HTMLInputElement;
  const groups = el('div', 'gg-work-groups');
  const conflictHead = mkGroupHead(true);
  const conflictBox = el('div', 'gg-work-rows');
  const stagedHead = mkGroupHead();
  const stagedBox = el('div', 'gg-work-rows');
  const unstagedHead = mkGroupHead();
  const unstagedBox = el('div', 'gg-work-rows');
  fbtns.append(refreshBtn, cleanTempBtn, unstageAllBtn, stageAllBtn);
  fhead.append(ftitle, fbtns);
  groups.append(conflictHead.el, conflictBox, stagedHead.el, stagedBox, unstagedHead.el, unstagedBox);
  files.append(fhead, fsearch, groups);

  // 冲突组批量按钮（组头右侧）：全部用我的 / 全部用对方的
  const conflictBtns = el('div', 'gg-work-cbtns');
  const allOursBtn = el('button', 'gg-btn tiny');
  const allTheirsBtn = el('button', 'gg-btn tiny');
  conflictBtns.append(allOursBtn, allTheirsBtn);
  conflictHead.el.querySelector('.gg-work-cnt')!.after(conflictBtns);
  allOursBtn.addEventListener('click', e => {
    e.stopPropagation();   // 不触发组头折叠
    for (const c of S.work.state?.conflicts ?? []) app.mergeResolve(c.path, false);
  });
  allTheirsBtn.addEventListener('click', e => {
    e.stopPropagation();
    for (const c of S.work.state?.conflicts ?? []) app.mergeResolve(c.path, true);
  });
  bindCollapse(conflictHead, conflictBox);
  bindCollapse(stagedHead, stagedBox);
  bindCollapse(unstagedHead, unstagedBox);

  // 分组头（元素只建一次：折叠监听不随 update 累积；每组只折叠自己的行容器）
  function mkGroupHead(conflict = false): { el: HTMLElement; caret: HTMLElement; name: HTMLElement; cnt: HTMLElement; isCollapsed(): boolean } {
    const g = el('div', 'gg-work-group-h' + (conflict ? ' conflict' : ''));
    const caret = el('span', 'gg-work-caret', '▾');
    const name = el('b');
    const cnt = el('span', 'gg-work-cnt', '0');
    g.append(caret, name, cnt);
    return { el: g, caret, name, cnt, isCollapsed: () => g.classList.contains('collapsed') };
  }

  function bindCollapse(head: { el: HTMLElement; caret: HTMLElement; isCollapsed(): boolean }, box: HTMLElement): void {
    head.el.addEventListener('click', () => {
      head.el.classList.toggle('collapsed');
      head.caret.textContent = head.isCollapsed() ? '▸' : '▾';
      box.classList.toggle('hidden', head.isCollapsed());
    });
  }

  // 列宽拖拽（200 起，上限=容器宽-360 保证 diff 区可用；持久化到宿主）
  const resizer = el('div', 'gg-work-resizer');
  resizer.addEventListener('pointerdown', e => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = files.getBoundingClientRect().width;
    const move = (ev: PointerEvent) => {
      const maxW = Math.max(220, root.clientWidth - 360);
      const w = Math.max(200, Math.min(maxW, startW + ev.clientX - startX));
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

  /** Office 锁定临时文件（Word/PPT/Excel 打开时产生，~$ 开头；关闭文档后即为垃圾） */
  function officeTemps(): string[] {
    const st = S.work.state;
    if (!st) return [];
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    return [...st.unstaged, ...st.staged]
      .filter(e => base(e.path).startsWith('~$'))
      .map(e => e.path);
  }
  cleanTempBtn.addEventListener('click', () => {
    const temps = officeTemps();
    if (temps.length) app.deleteFile(temps);   // 复用「删除文件」：磁盘移除 + 关闭悬空标签 + 刷新列表
  });
  // 手动刷新：编辑器改文件不动 .git/index（watcher 侦听不到），点击立即跑 git status 取最新修改状态
  refreshBtn.addEventListener('click', () => {
    app.requestWorkState();
    refreshBtn.classList.remove('spin');
    void refreshBtn.offsetWidth;   // 重启动画
    refreshBtn.classList.add('spin');
  });
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
  const prevBtn = el('button', 'gg-icon-btn');
  const nextBtn = el('button', 'gg-icon-btn');
  const openBtn = el('button', 'gg-icon-btn');
  const nativeBtn = el('button', 'gg-icon-btn');
  const copyBtn = el('button', 'gg-icon-btn');
  const revealBtn = el('button', 'gg-icon-btn');
  setIcon(prevBtn, 'chevronLeft');
  setIcon(nextBtn, 'chevronRight');
  setIcon(openBtn, 'goToFile');
  setIcon(nativeBtn, 'compare');
  setIcon(copyBtn, 'copy');
  setIcon(revealBtn, 'folder');
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
    return [...st.conflicts, ...st.staged, ...st.unstaged].filter(match);
  }

  /** 冲突行：状态码 ⚠ + 文件名 + 行内「合并…」与「我的/他人的」二选一（语义侧，扩展侧映射 ours/theirs）；
   *  resolving 乐观态（Issue #7）：点选边后行内 ⏳ + 按钮禁点，opResult/workState 解除 */
  function conflictRow(e: FileEntry, mergeKind: 'merge' | 'rebase' | 'other'): HTMLElement {
    const resolving = S.work.resolving.has(e.path);
    const r = el('div', 'gg-work-row conflict' + (e.path === S.work.selectedPath ? ' selected' : '') + (resolving ? ' resolving' : ''));
    r.appendChild(el('span', 'gg-st C', resolving ? '⏳' : 'C'));
    const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
    const pathEl = el('span', 'gg-work-fpath');
    pathEl.appendChild(el('b', undefined, base(e.path)));
    pathEl.title = e.path;
    r.appendChild(pathEl);
    const btns = el('div', 'gg-work-cbtns');
    const mergeBtn = el('button', 'gg-btn tiny merge', S.t('mergeOpenBtn'));
    mergeBtn.title = S.t('mergeOpenBtnTip');
    mergeBtn.addEventListener('click', ev => { ev.stopPropagation(); app.openMerge(e.path); });
    const mineLabel = mergeKind === 'merge' ? S.t('resolveOurs') : mergeKind === 'rebase' ? S.t('resolveOurs') : S.t('resolveOursOther');
    const theirsLabel = mergeKind === 'other' ? S.t('resolveTheirsOther') : S.t('resolveTheirs');
    const oursBtn = el('button', 'gg-btn tiny', mineLabel);
    const theirsBtn = el('button', 'gg-btn tiny', theirsLabel);
    oursBtn.title = mergeKind === 'rebase' ? S.t('resolveOursRebaseTip') : S.t('resolveOursTip');
    theirsBtn.title = S.t('resolveTheirsTip');
    // 语义侧调用（merge: mine=--ours；rebase: mine=--theirs，反转由扩展侧完成）
    oursBtn.addEventListener('click', ev => { ev.stopPropagation(); app.mergeResolve(e.path, false); });
    theirsBtn.addEventListener('click', ev => { ev.stopPropagation(); app.mergeResolve(e.path, true); });
    if (resolving) { oursBtn.disabled = true; theirsBtn.disabled = true; mergeBtn.disabled = true; }
    btns.append(mergeBtn, oursBtn, theirsBtn);
    r.appendChild(btns);
    r.addEventListener('click', () => selectEntry(e));
    return r;
  }

  function selectEntry(e: FileEntry): void {
    S.work.selectedPath = e.path;
    S.work.selectedStaged = !!e.staged;
    S.work.diff = undefined;
    app.requestWorkDiff(e.path);
    update();
  }

  // ---------- 渲染 ----------

  /** 冲突横幅：merging=红（待解决）；mergeActive 且清零=绿（待完成合并）；否则隐藏 */
  function updateBanner(): void {
    const st = S.work.state;
    clearChildren(bannerBtns);
    if (!st) { banner.classList.add('hidden'); return; }
    const n = st.conflicts.length;
    const kindText = S.t(st.mergeKind === 'rebase' ? 'mergeKindRebase' : st.mergeKind === 'merge' ? 'mergeKindMerge' : 'mergeKindOther');
    if (n > 0) {
      banner.classList.remove('hidden', 'ok');
      banner.classList.add('warn');
      bannerText.textContent = S.t('mergeBannerTitle', { kind: kindText, n: String(n) });
      const mk = (label: string, cls: string, fn: () => void, confirmN?: number) => {
        const b = el('button', 'gg-btn tiny ' + cls, label);
        b.addEventListener('click', () => {
          if (confirmN === undefined) { fn(); return; }
          void confirmDialog(label, S.t('mergeBannerAllConfirm', { n: String(confirmN) }), S.t('confirm'), true).then(ok => { if (ok) fn(); });
        });
        return b;
      };
      bannerBtns.append(
        mk(S.t('mergeBannerResolve'), 'primary', () => app.openMerge()),
        mk(S.t('mergeBannerAllMine'), '', () => { for (const c of st.conflicts) app.mergeResolve(c.path, false); }, n),
        mk(S.t('mergeBannerAllTheirs'), '', () => { for (const c of st.conflicts) app.mergeResolve(c.path, true); }, n),
        mk(S.t('mergeBannerAbort'), 'danger', () => app.mergeAbort()),
      );
      return;
    }
    if (st.mergeActive) {
      // 冲突已清但未完成提交（决议 #2 的「稍后」状态）
      banner.classList.remove('hidden', 'warn');
      banner.classList.add('ok');
      bannerText.textContent = S.t('mergePendingTitle');
      const finish = el('button', 'gg-btn tiny primary', S.t('mergeFinishShort'));
      finish.addEventListener('click', () => app.mergeFinishAsk());
      const abort = el('button', 'gg-btn tiny danger', S.t('mergeAbortBtn'));
      abort.addEventListener('click', () => app.mergeAbort());
      bannerBtns.append(finish, abort);
      return;
    }
    // 手动移动检测（v0.14 R7）：未暂存"同前缀批量删除 + 同名未跟踪"→ 引导按移动 stage 并预填信息
    const md = st.moveDetect;
    if (md) {
      banner.classList.remove('hidden', 'warn', 'ok');
      banner.classList.add('mv');
      bannerText.textContent = S.t('moveDetectText', { from: md.from || '/', to: md.to || '/', n: String(md.count) });
      const commitMove = el('button', 'gg-btn tiny primary', S.t('moveDetectStage'));
      commitMove.addEventListener('click', () => {
        app.workStage(md.paths, true);
        S.work.message = S.t('moveCommitMsg', { from: md.from || '/', to: md.to || '/' });
        update();
      });
      const skip = el('button', 'gg-btn tiny', S.t('moveIgnore'));
      skip.addEventListener('click', () => { st.moveDetect = undefined; update(); });
      bannerBtns.append(commitMove, skip);
      return;
    }
    banner.classList.add('hidden');
  }

  function update(): void {
    const w = S.work;
    const st = w.state;
    updateBanner();
    ftitle.textContent = S.t('workFiles');
    stageAllBtn.title = S.t('stageAll');
    unstageAllBtn.title = S.t('unstageAll');
    refreshBtn.title = S.t('refreshWork');
    const temps = officeTemps().length;
    cleanTempBtn.classList.toggle('hidden', !temps);
    cleanTempBtn.title = S.t('cleanTempTip', { n: String(temps) });
    fsearch.placeholder = S.t('filterFiles');
    prevBtn.title = S.t('prevFile');
    nextBtn.title = S.t('nextFile');
    openBtn.title = S.t('openFile');
    nativeBtn.title = S.t('openInDiffEditor');
    copyBtn.title = S.t('copyPath');
    revealBtn.title = S.t('revealInFM');

    if (!st) {
      conflictHead.el.classList.add('hidden');
      renderGroup(stagedHead, stagedBox, S.t('workStaged'), [], true);
      renderGroup(unstagedHead, unstagedBox, S.t('workUnstaged'), [], false);
      renderEmptyDiff();
      return;
    }

    const f = w.filter;
    const match = (e: FileEntry) => !f || e.path.toLowerCase().includes(f);
    // 冲突组置顶：红标题 + 逐文件「我的/对方的」+ 组头批量按钮（merge 语义=我的/对方的；其他场景 ours/theirs）
    const conflicts = st.conflicts.filter(match);
    conflictHead.el.classList.toggle('hidden', !st.conflicts.length);
    conflictHead.name.textContent = S.t('workConflicts');
    conflictHead.cnt.textContent = String(st.conflicts.length);
    conflictBtns.classList.toggle('hidden', !conflicts.length);
    allOursBtn.textContent = st.mergeKind === 'other' ? S.t('resolveAllOursOther') : S.t('resolveAllOurs');
    allTheirsBtn.textContent = st.mergeKind === 'other' ? S.t('resolveAllTheirsOther') : S.t('resolveAllTheirs');
    conflictBox.classList.toggle('hidden', conflictHead.isCollapsed() || !st.conflicts.length);
    clearChildren(conflictBox);
    appendGrouped(conflictBox, conflicts, e => conflictRow(e, st.mergeKind));
    renderGroup(stagedHead, stagedBox, S.t('workStaged'), st.staged.filter(match), true);
    renderGroup(unstagedHead, unstagedBox, S.t('workUnstaged'), st.unstaged.filter(match), false);

    // 干净的工作副本 → 空状态
    if (!st.staged.length && !st.unstaged.length && !st.conflicts.length) {
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
    appendGrouped(box, list, e => row(e, head === stagedHead));
  }

  /**
   * 按目录分组渲染（与提交详情一致）：目录头行显示完整路径一次（根目录显示仓库绝对路径），
   * 组内行只显示文件名；目录按字母序、根目录置顶，组内按路径序。
   */
  function appendGrouped(box: HTMLElement, list: FileEntry[], mkRow: (e: FileEntry) => HTMLElement): void {
    if (!list.length) return;
    const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path));
    const repoRoot = S.repos.find(r => r.id === S.repoId)?.root;
    let curDir: string | null = null;
    for (const e of sorted) {
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/') + 1) : '';
      if (dir !== curDir) {
        curDir = dir;
        const text = dir === '' ? (repoRoot ?? '/') : dir;
        const h = el('div', 'gg-work-dirgroup', text);
        h.title = text;
        box.appendChild(h);
      }
      box.appendChild(mkRow(e));
    }
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
    const pathEl = el('span', 'gg-work-fpath');
    if (e.origPath) {
      pathEl.appendChild(el('span', 'gg-work-fdir', base(e.origPath) + ' → '));
      pathEl.appendChild(el('b', undefined, base(e.path)));
      pathEl.title = `${e.origPath} → ${e.path}`;
    } else {
      pathEl.appendChild(el('b', undefined, base(e.path)));
      pathEl.title = e.path;
    }
    r.appendChild(pathEl);
    // 增减行数已不显示（文件名占满行宽）；未跟踪仍以文字标签提示状态
    if (e.untracked) {
      const badge = el('span', 'gg-work-fnum');
      badge.appendChild(el('i', undefined, S.t('untrackedLabel')));
      r.appendChild(badge);
    }

    // 行内快捷操作（hover 显示）：新选项卡打开（可编辑）/ 复制文件名 / 复制路径 / 删除
    const acts = el('div', 'gg-work-acts');
    const mkAct = (icon: IconName, title: string, extra: string, run: () => void): HTMLElement => {
      const b = el('button', 'gg-work-act' + (extra ? ' ' + extra : ''));
      setIcon(b, icon);
      b.title = title;
      b.addEventListener('click', ev => { ev.stopPropagation(); run(); });
      return b;
    };
    acts.append(
      mkAct('goToFile', S.t('openFile'), '', () => app.openFile(e.path)),
      mkAct('copyName', S.t('copyFileName'), '', () => app.copy(base(e.path))),
      mkAct('copy', S.t('copyPath'), '', () => app.copy(e.path)),
      // 行内删除：从磁盘移除，语义与「丢弃」（恢复内容）相反
      mkAct('trash', S.t('deleteFile'), 'gg-work-del', () => askDelete([e.path])),
    );
    r.appendChild(acts);

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
        { label: `${S.t('deleteFile')}…`, danger: true, run: () => askDelete([e.path]) },
        { label: S.t('openFile'), run: () => app.openFile(e.path) },
        { label: S.t('revealInFM'), run: () => app.revealInFM(e.path) },
        { label: S.t('copyFileName'), run: () => app.copy(base(e.path)) },
        { label: S.t('copyPath'), run: () => app.copy(e.path) },
      );
      showContextMenu(items, ev.clientX, ev.clientY);
    });
    return r;
  }

  function askDelete(paths: string[]): void {
    const n = paths.length;
    void confirmDialog(
      S.t('deleteFileConfirmTitle', { n }),
      S.t('deleteFileConfirmText', { n }) + '\n\n' + paths.slice(0, 8).join('\n') + (n > 8 ? `\n…(+${n - 8})` : ''),
      S.t('deleteFile'),
      true,
    ).then(ok => { if (ok) app.deleteFile(paths); });
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
  return {
    el: outer, update, updateDiff,
    applyFilesWidth(w: number): void {
      // ready 时视图可能仍隐藏（clientWidth=0），相对钳制交给 CSS max-width:calc(100% - 340px)，此处只防异常值
      files.style.width = `${Math.max(200, Math.min(900, w))}px`;
    },
  };
}
