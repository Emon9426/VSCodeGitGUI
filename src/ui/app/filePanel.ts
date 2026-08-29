/**
 * 文件历史页 · 右区文件面板（v0.14）：
 * 文件头（类型图标/路径/链徽标/跟随开关）→ 移动引导横幅 →（多选批量面板 | 提交记录列表）。
 * 提交记录行：比对勾选 + 时间线圆点 + 说明（里程碑徽标）+ 时期徽标 + 作者/时间 + 行尾 ⓘ 详情 / 📄 打开此版本；
 * 勾选恰好 2 条 → 比对条 → blob 级 diff 视图（跨移动/重命名有效）。
 */
import type { DiffPayload, FileHistoryItem } from '../../common/models';
import { S, type App } from '../state';
import { el, formatDateTime } from '../util';
import { fileIconSvg } from '../icons';
import { renderDiff } from '../diff/render';
import { confirmDialog, toast } from './overlays';

export function createFilePanel(app: App) {
  const root = el('div', 'gg-filepanel');

  // ---------- 文件头 ----------
  const fh = el('div', 'gg-fp-head');
  const fhIco = el('span', 'gg-fp-ico');
  const fhName = el('span', 'gg-fp-name');
  const fhCrumb = el('span', 'gg-fp-crumb');
  const chain = el('span', 'gg-fp-chain');
  const fol = el('button', 'gg-fp-fol') as HTMLButtonElement;
  const folSw = el('span', 'gg-fp-sw');
  const folLabel = el('span', undefined, S.t('filesFollow'));
  fol.append(folSw, folLabel);
  fol.addEventListener('click', () => {
    S.files.follow = !S.files.follow;
    if (S.files.histFor) app.filesSelect(S.files.histFor, S.files.histIsDir);
    update();
  });
  fh.append(fhIco, fhName, fhCrumb, chain, el('span', 'gg-fp-sp'), fol);
  root.append(fh);

  // ---------- 移动引导横幅 ----------
  const banner = el('div', 'gg-fp-banner hidden');
  const bannerText = el('span', 'gg-fp-banner-t');
  const bannerBtn = el('button', 'gg-fp-banner-btn hero') as HTMLButtonElement;
  bannerBtn.textContent = '';   // fill in update
  const bannerSkip = el('button', 'gg-fp-banner-btn') as HTMLButtonElement;
  bannerSkip.textContent = S.t('moveIgnore');
  banner.append(el('span', undefined, '🗂'), bannerText, el('span', 'gg-fp-sp'), bannerBtn, bannerSkip);
  bannerBtn.addEventListener('click', () => {
    const mb = S.files.moveBanner;
    if (!mb) return;
    // 引导纯移动提交：切到工作副本并预填信息（复用现有 commit 流程）
    S.work.message = S.t('moveCommitMsg', { from: mb.srcs[0] ?? '', to: mb.dst });
    S.files.moveBanner = undefined;
    app.setView('work');
    update();
  });
  bannerSkip.addEventListener('click', () => { S.files.moveBanner = undefined; update(); });
  root.append(banner);

  // ---------- 多选批量面板 ----------
  const multi = el('div', 'gg-fp-multi hidden');
  root.append(multi);

  // ---------- 历史列表 ----------
  const histWrap = el('div', 'gg-fp-hist');
  const histHead = el('div', 'gg-fp-histhead');
  const histCount = el('span', 'gg-fp-cnt');
  const histNote = el('span', 'gg-fp-note');
  const histOpsHint = el('span', 'gg-fp-opshint');
  histHead.append(el('span', undefined, S.t('filesHist')), histCount, histNote, el('span', 'gg-fp-sp'), histOpsHint);
  const histList = el('div', 'gg-fp-list');
  const cmpBar = el('div', 'gg-fp-cmpbar hidden');
  const cmpText = el('span');
  const cmpBtn = el('button', 'gg-fp-cmpbtn') as HTMLButtonElement;
  cmpBtn.textContent = S.t('filesCmpBtn');
  cmpBtn.addEventListener('click', () => app.filesVersionDiff());
  cmpBar.append(cmpText, cmpBtn);
  histWrap.append(histHead, histList, cmpBar);
  root.append(histWrap);

  // ---------- 比对 diff 视图 ----------
  const diffWrap = el('div', 'gg-fp-diff hidden');
  const diffHead = el('div', 'gg-fp-diffhead');
  const backBtn = el('button', 'gg-fp-back') as HTMLButtonElement;
  backBtn.textContent = '⟵ ' + S.t('filesBack');
  backBtn.addEventListener('click', () => {
    S.files.diff = undefined;
    S.files.diffPair = undefined;
    update();
  });
  const diffPair = el('span', 'gg-fp-pair');
  const diffStat = el('span', 'gg-fp-stat');
  diffHead.append(backBtn, diffPair, diffStat);
  const diffBody = el('div', 'gg-fp-diffbody');
  diffWrap.append(diffHead, diffBody);
  root.append(diffWrap);

  // ---------- 渲染 ----------
  function shortEra(p: string): string {
    const i = p.lastIndexOf('/');
    return i < 0 ? p : p.slice(i + 1);
  }

  function update(): void {
    // 横幅
    const mb = S.files.moveBanner;
    banner.classList.toggle('hidden', !mb);
    if (mb) {
      bannerText.innerHTML = '';
      bannerText.append(document.createTextNode(S.t('moveBannerText', { from: mb.from || (mb.srcs[0] ?? ''), to: mb.dst || '/', n: String(mb.srcs.length) })));
      bannerBtn.textContent = S.t('moveCommitBtn');
    }
    // 比对态优先
    if (S.files.diff && S.files.diffPair) {
      fh.classList.add('hidden');
      multi.classList.add('hidden');
      histWrap.classList.add('hidden');
      diffWrap.classList.remove('hidden');
      const { a, b } = S.files.diffPair;
      diffPair.textContent = '';
      diffPair.append(
        el('b', undefined, a.shortSha), document.createTextNode(` · ${a.path}`),
        el('span', 'gg-fp-arrow', '⇢'),
        el('b', undefined, b.shortSha), document.createTextNode(` · ${b.path}`),
      );
      diffStat.textContent = S.files.diff.kind === 'binary' ? S.t('binaryFile') : '';
      renderDiff(diffBody, S.files.diff, a.path, true, () => undefined);
      return;
    }
    diffWrap.classList.add('hidden');

    const selN = S.files.sel.length;
    // 多选批量面板
    if (selN > 1) {
      fh.classList.add('hidden');
      histWrap.classList.add('hidden');
      multi.classList.remove('hidden');
      renderMulti();
      return;
    }
    multi.classList.add('hidden');
    fh.classList.remove('hidden');
    histWrap.classList.remove('hidden');
    renderHead();
    renderHist();
  }

  function renderHead(): void {
    const forPath = S.files.histFor;
    fhIco.textContent = '';
    fhName.textContent = '';
    fhCrumb.textContent = '';
    chain.textContent = '';
    chain.classList.toggle('off', !S.files.follow);
    fol.classList.toggle('off', !S.files.follow);
    folLabel.textContent = S.t('filesFollow');
    if (!forPath) {
      fhName.textContent = S.t('filesNoSel');
      histOpsHint.textContent = '';
      return;
    }
    const name = forPath.includes('/') ? forPath.slice(forPath.lastIndexOf('/') + 1) : forPath;
    const isDir = S.files.histIsDir;
    fhIco.append(fileIconSvg(name, isDir, 18));
    fhName.textContent = name;
    fhCrumb.textContent = forPath.includes('/') ? forPath.slice(0, forPath.lastIndexOf('/')).replace(/\//g, ' › ') : S.t('filesRootCrumb');
    const segs = S.files.history?.chain.segments ?? [];
    if (segs.length > 1) {
      for (let i = segs.length - 1; i >= 0; i--) {   // 旧→新显示，当前段（segments[0]）绿色
        if (i < segs.length - 1) chain.append(el('span', 'gg-fp-chain-ar', '→'));
        const s = el(i === 0 ? 'b' : 'span', i === 0 ? 'gg-fp-chain-cur' : 'gg-fp-chain-old', shortEra(segs[i].prefix));
        chain.append(s);
      }
      chain.title = segs.map(s => s.prefix).join(' → ');
    }
  }

  function renderMulti(): void {
    multi.textContent = '';
    multi.append(el('h3', undefined, S.t('filesSelMulti', { n: String(S.files.sel.length) })));
    multi.append(el('div', 'gg-fp-multi-sub', S.t('filesMultiHint')));
    const ops = el('div', 'gg-fp-multi-ops');
    const bDel = el('button', 'gg-files-cbtn danger') as HTMLButtonElement;
    bDel.textContent = `🗑 ${S.t('filesDelete')}（${S.files.sel.length}）`;
    bDel.addEventListener('click', () => app.folderDelete([...S.files.sel]));
    const bMove = el('button', 'gg-files-cbtn') as HTMLButtonElement;
    bMove.textContent = `✂ ${S.t('filesMove')}（${S.files.sel.length}）`;
    bMove.addEventListener('click', () => app.folderMove([...S.files.sel]));
    ops.append(bDel, bMove);
    multi.append(ops);
    const listBox = el('div', 'gg-fp-multi-list');
    for (const p of S.files.sel) {
      const name = p.slice(p.lastIndexOf('/') + 1);
      const isDir = !!S.files.items.find(x => x.path === p)?.isDir;
      const row = el('div', 'gg-fp-multi-row');
      row.append(fileIconSvg(name, isDir), el('span', undefined, name), el('span', 'gg-fp-multi-path', p));
      listBox.append(row);
    }
    multi.append(listBox);
  }

  function renderHist(): void {
    const hist = S.files.history;
    const items = hist ? hist.items.filter(x => S.files.follow || !x.eraPrefix) : [];
    histCount.textContent = String(items.length);
    const nChanges = (hist?.chain.segments.length ?? 1) - 1;
    histNote.textContent = S.files.follow
      ? (nChanges > 0 ? S.t('filesFollowN', { n: String(nChanges) }) : '')
      : S.t('filesFollowOff');
    histOpsHint.textContent = S.t('filesOpsHint');
    histList.textContent = '';
    if (S.files.histLoading) {
      histList.append(el('div', 'gg-fp-empty', S.t('loading')));
      return;
    }
    if (!S.files.histFor) {
      histList.append(el('div', 'gg-fp-empty', S.t('filesPickHint')));
      return;
    }
    if (!items.length) {
      histList.append(el('div', 'gg-fp-empty', S.t('filesNoHist')));
      return;
    }
    items.forEach((it, idx) => {
      const row = el('div', 'gg-fp-row' + (it.milestone ? ' mile' : '') + (S.files.detailSha === it.sha ? ' open' : ''));
      if (idx === 0) row.classList.add('first');
      if (idx === items.length - 1) row.classList.add('last');
      // 勾选框（恰好 2 条，第 3 个挤掉最早）
      const ck = el('span', 'gg-fp-ck' + (S.files.picked.some(p => p.sha === it.sha) ? ' on' : ''));
      ck.textContent = S.files.picked.some(p => p.sha === it.sha) ? '✓' : '';
      ck.addEventListener('click', e => {
        e.stopPropagation();
        const i = S.files.picked.findIndex(p => p.sha === it.sha);
        if (i >= 0) S.files.picked.splice(i, 1);
        else {
          S.files.picked.push(it);
          if (S.files.picked.length > 2) S.files.picked.shift();
        }
        update();
      });
      // 时间线圆点
      const tl = el('span', 'gg-fp-tl');
      tl.append(el('span', 'gg-fp-dot'));
      // 说明 + 徽标
      const msg = el('span', 'gg-fp-msg');
      if (it.milestone) {
        const from = it.oldPath ?? it.path;
        const mb = el('span', 'gg-fp-mb', `⇢ ${shortEra(from)} → ${shortEra(it.path)}`);
        mb.title = `${from} → ${it.path}`;
        msg.append(mb);
      }
      msg.append(document.createTextNode(it.subject));
      msg.title = it.subject;
      // 时期徽标（当前段无）
      const eraPrefix = it.eraPrefix;
      const era = eraPrefix && S.files.follow ? el('span', 'gg-fp-era', shortEra(eraPrefix)) : null;
      if (era) era.title = eraPrefix ?? '';
      const aut = el('span', 'gg-fp-aut', it.author);
      aut.title = it.author;
      const tim = el('span', 'gg-fp-tim', formatDateTime(it.date));
      // 行尾操作
      const acts = el('span', 'gg-fp-acts');
      const aInfo = el('button', 'gg-fp-act') as HTMLButtonElement;
      aInfo.title = S.t('filesDetail');
      aInfo.textContent = 'ⓘ';
      aInfo.addEventListener('click', e => { e.stopPropagation(); toggleDetail(it); });
      const aVer = el('button', 'gg-fp-act') as HTMLButtonElement;
      aVer.title = S.t('filesOpenVer');
      aVer.textContent = '📄';
      aVer.addEventListener('click', e => { e.stopPropagation(); app.openFileAt(it.sha, it.path); });
      acts.append(aInfo, aVer);
      row.append(ck, tl, msg);
      if (era) row.append(era);
      row.append(aut, tim, acts);
      row.addEventListener('click', () => toggleDetail(it));
      histList.append(row);
      // 详情就地展开（同一时间仅一处）
      if (S.files.detailSha === it.sha) {
        histList.append(buildDetailBox(it));
      }
    });
    // 比对条
    if (S.files.picked.length === 2) {
      cmpBar.classList.remove('hidden');
      const [a, b] = S.files.picked;
      cmpText.textContent = S.t('filesCmpSel', { a: a.shortSha, b: b.shortSha });
    } else {
      cmpBar.classList.add('hidden');
    }
  }

  function toggleDetail(it: FileHistoryItem): void {
    if (S.files.detailSha === it.sha) {
      S.files.detailSha = undefined;
      S.files.detailDiff = undefined;
      update();
      return;
    }
    S.files.detailSha = it.sha;
    S.files.detailDiff = undefined;
    update();
    app.filesCommitDiff(it.sha, it.path);
  }

  function buildDetailBox(it: FileHistoryItem): HTMLElement {
    const box = el('div', 'gg-fp-detail');
    const dh = el('div', 'gg-fp-detail-h');
    dh.append(
      el('span', undefined, `${S.t('commit')} `),
      el('b', 'gg-fp-sha', it.shortSha),
      el('span', undefined, ` · ${it.author} · ${formatDateTime(it.date)}`),
      el('span', 'gg-fp-sp'),
      el('span', 'gg-fp-detail-path', `${S.t('filesPathAt')} `),
      el('b', 'gg-fp-detail-path-b', it.path),
    );
    box.append(dh);
    const body = el('div', 'gg-fp-detail-body');
    if (S.files.detailDiff) {
      renderDiff(body, S.files.detailDiff, it.path, true, () => undefined);
    } else {
      body.append(el('div', 'gg-fp-empty', S.t('loading')));
    }
    box.append(body);
    return box;
  }

  function reset(): void {
    S.files.history = undefined;
    S.files.histFor = undefined;
    S.files.picked = [];
    S.files.detailSha = undefined;
    S.files.detailDiff = undefined;
    S.files.diff = undefined;
    S.files.diffPair = undefined;
    S.files.moveBanner = undefined;
    update();
  }

  return { el: root, update, reset };
}
