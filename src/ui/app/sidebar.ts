/**
 * 左侧边栏（设计方案 4.2）：工程区（v0.11 跨工作区切换）、仓库区、本地分支（ahead/behind 徽标）、远程、标签。
 * 单击分支 = 过滤提交图；双击 = 检出；右键 = 操作菜单。
 * 工程区：双击在当前窗口打开工程；右键可新窗口打开/重命名/移除。
 */
import type { BranchInfo } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren } from '../util';
import { showContextMenu, confirmDialog, promptDialog, tagDialog } from './overlays';

export interface Sidebar {
  el: HTMLElement;
  update(): void;
}

export function createSidebar(app: App): Sidebar {
  const root = el('div', 'gg-side');
  const projSec = section(S.t('projects'));
  const repoSec = section(S.t('repos'));
  const branchSec = section(S.t('branches'));
  const remoteSec = section(S.t('remotes'));
  const tagSec = section(S.t('tags'));
  root.append(projSec.box, repoSec.box, branchSec.box, remoteSec.box, tagSec.box);

  function section(title: string): { box: HTMLElement; list: HTMLElement } {
    const box = el('div', 'gg-side-sec');
    box.appendChild(el('div', 'gg-side-h', title));
    const list = el('div', 'gg-side-list');
    box.appendChild(list);
    return { box, list };
  }

  function sectionTitle(sec: { box: HTMLElement }, title: string): void {
    (sec.box.firstChild as HTMLElement).textContent = title;
  }

  function update(): void {
    // 工程（标题随语言刷新；＋入口挂标题栏，与标签区同款）
    sectionTitle(projSec, S.t('projects'));
    let projAdd = projSec.box.querySelector('.gg-side-add') as HTMLElement | null;
    if (!projAdd) {
      projAdd = el('button', 'gg-side-add', '＋');
      projAdd.addEventListener('click', e => {
        e.stopPropagation();
        showProjectAddMenu(e.clientX, e.clientY);
      });
      projSec.box.firstElementChild!.appendChild(projAdd);
    }
    projAdd.title = S.t('projectAdd');
    clearChildren(projSec.list);
    for (const p of S.projects) projSec.list.appendChild(projectRow(app, p));
    if (!S.projects.length) {
      projSec.list.appendChild(el('div', 'gg-side-empty', S.t('noProjects')));
    }

    // 仓库（标题随语言刷新：其余三个分区在下方 sectionTitle 处理）
    sectionTitle(repoSec, S.t('repos'));
    clearChildren(repoSec.list);
    for (const r of S.repos) {
      const st = r.id === S.repoId ? S.state : undefined;
      const item = el('div', `gg-side-item repo${r.id === S.repoId ? ' active' : ''}`);
      item.appendChild(el('span', 'gg-side-name', `⑂ ${r.name}`));
      if (st) {
        item.appendChild(el('span', 'gg-side-sub', st.head.detached ? S.t('detachedHead') : st.head.branch ?? ''));
      }
      item.addEventListener('click', () => app.selectRepo(r.id));
      repoSec.list.appendChild(item);
    }
    if (!S.repos.length) {
      if (S.reposPending) {
        // v0.14.7：仓库扫描中——轻量加载行（spinner + 文案），替代静默空文案
        const row = el('div', 'gg-side-empty');
        row.style.display = 'flex';
        row.style.alignItems = 'center';
        row.style.gap = '6px';
        const sp = el('span', 'gg-spinner');
        sp.style.width = sp.style.height = '10px';
        row.append(sp, el('span', undefined, S.t('loadingRepos')));
        repoSec.list.appendChild(row);
      } else {
        repoSec.list.appendChild(el('div', 'gg-side-empty', S.t('noRepos')));
      }
    }

    const st = S.state;
    sectionTitle(branchSec, `${S.t('branches')} (${st?.branches.length ?? 0})`);
    clearChildren(branchSec.list);
    if (st) {
      for (const b of st.branches) branchSec.list.appendChild(branchRow(app, b));
    }

    sectionTitle(remoteSec, S.t('remotes'));
    clearChildren(remoteSec.list);
    if (st) {
      for (const g of st.remotes) {
        const group = el('div', 'gg-side-group');
        const gh = el('div', 'gg-side-item group');
        gh.appendChild(el('span', 'gg-side-name', `⇅ ${g.name}`));
        gh.addEventListener('contextmenu', e => {
          e.preventDefault();
          showContextMenu([
            { label: S.t('fetchAll'), run: () => app.runFetch() },
          ], e.clientX, e.clientY);
        });
        group.appendChild(gh);
        for (const b of g.branches) group.appendChild(remoteRow(app, b, g.name));
        remoteSec.list.appendChild(group);
      }
    }

    sectionTitle(tagSec, `${S.t('tags')} (${st?.tags.length ?? 0})`);
    // 标签区标题旁 ➕：在 HEAD 上新建
    if (!tagSec.box.querySelector('.gg-side-add')) {
      const add = el('button', 'gg-side-add', '＋');
      add.title = S.t('newTag');
      add.addEventListener('click', () => {
        void tagDialog(S.state?.head.sha.slice(0, 7) ?? '', S.t).then(r => {
          if (r) app.tagCreate(r.name, S.state?.head.sha, r.message || undefined);
        });
      });
      tagSec.box.firstElementChild!.appendChild(add);
    }
    clearChildren(tagSec.list);
    if (st) {
      for (const tg of st.tags) {
        const item = el('div', `gg-side-item tag${S.state?.filterRef === tg.name ? ' filtered' : ''}`);
        item.appendChild(el('span', 'gg-side-name', tg.name));
        item.title = tg.date ?? tg.name;
        filterClick(item, tg.name);
        item.addEventListener('contextmenu', e => {
          e.preventDefault();
          showContextMenu([
            { label: S.t('checkoutTag'), run: () => app.checkoutDetached(tg.sha) },
            { label: S.t('pushThisTag'), run: () => app.tagPush(tg.name) },
            { sep: true },
            { label: S.t('copyTagName'), run: () => app.copy(tg.name) },
            { label: S.t('tagDelete'), danger: true, run: () => {
              void confirmDialog(S.t('tagDelete'), S.t('tagDeleteConfirm', { name: tg.name }), S.t('tagDelete'), true)
                .then(ok => { if (ok) app.tagDelete(tg.name); });
            } },
            { label: S.t('tagDeleteRemote'), danger: true, run: () => {
              void confirmDialog(S.t('tagDeleteRemote'), S.t('tagDeleteRemoteConfirm', { name: tg.name }), S.t('tagDeleteRemote'), true)
                .then(ok => { if (ok) app.tagDelete(tg.name, 'origin'); });
            } },
          ], e.clientX, e.clientY);
        });
        tagSec.list.appendChild(item);
      }
    }
  }

  function filterClick(item: HTMLElement, ref: string): void {
    item.addEventListener('click', () => {
      app.setFilter(S.state?.filterRef === ref ? null : ref);
    });
  }

  function branchRow(app2: App, b: BranchInfo): HTMLElement {
    const item = el('div', `gg-side-item branch${b.isHead ? ' head' : ''}${S.state?.filterRef === b.fullName ? ' filtered' : ''}`);
    if (b.isHead) item.appendChild(el('span', 'gg-dot'));
    item.appendChild(el('span', 'gg-side-name', b.name));
    const badge = el('span', 'gg-ab');
    if (b.ahead) badge.appendChild(el('b', 'a', `↑${b.ahead}`));
    if (b.behind) badge.appendChild(el('b', 'd', `↓${b.behind}`));
    if (b.ahead || b.behind) item.appendChild(badge);
    item.title = b.subject ?? b.name;
    filterClick(item, b.fullName);
    item.addEventListener('dblclick', () => app2.checkoutRef(b.name));
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu([
        { label: S.t('checkout'), run: () => app2.checkoutRef(b.name) },
        { label: S.t('pullThis'), disabled: !b.upstream, run: () => app2.runPull() },
        { label: S.t('pushThis'), run: () => app2.runPush() },
        { sep: true },
        { label: S.t('copyBranchName'), run: () => app2.copy(b.name) },
      ], e.clientX, e.clientY);
    });
    return item;
  }

  function remoteRow(app2: App, b: BranchInfo, group: string): HTMLElement {
    const item = el('div', `gg-side-item remote${S.state?.filterRef === b.fullName ? ' filtered' : ''}`);
    item.appendChild(el('span', 'gg-side-name', b.name));
    item.title = b.subject ?? b.name;
    filterClick(item, b.fullName);
    item.addEventListener('dblclick', () => {
      const suggest = b.name.includes('/') ? b.name.split('/').slice(1).join('/') : b.name;
      app2.checkoutRemoteAs(b.name, suggest);
    });
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu([
        { label: S.t('checkoutAs'), run: () => {
          const suggest = b.name.includes('/') ? b.name.split('/').slice(1).join('/') : b.name;
          app2.checkoutRemoteAs(b.name, suggest);
        } },
        { label: S.t('fetchRemote'), run: () => app2.runFetch(group) },
        { sep: true },
        { label: S.t('copyBranchName'), run: () => app2.copy(b.name) },
      ], e.clientX, e.clientY);
    });
    return item;
  }

  // ---------- 工程（v0.11：跨工作区快速切换） ----------

  const dirBase = (p: string): string => {
    const tail = p.replace(/[\\/]+$/, '');
    const seg = tail.split(/[\\/]/).pop();
    return seg || tail || p;
  };

  function projectRow(app2: App, p: { id: string; name: string; path: string }): HTMLElement {
    const active = S.activeProjectIds.includes(p.id);
    const item = el('div', `gg-side-item project${active ? ' active' : ''}`);
    item.appendChild(el('span', 'gg-side-name', `▤ ${p.name}`));
    item.appendChild(el('span', 'gg-side-sub', p.path));
    item.title = `${p.name}\n${p.path}\n${S.t('projectSwitchTip')}`;
    item.addEventListener('dblclick', () => app2.projectOpen(p.id, false));   // 双击：当前窗口切换
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu([
        { label: S.t('projectOpenCurrent'), run: () => app2.projectOpen(p.id, false) },
        { label: S.t('projectOpenNew'), run: () => app2.projectOpen(p.id, true) },
        { sep: true },
        { label: S.t('projectRename'), run: () => {
          void promptDialog(S.t('projectRename'), S.t('projectNameLabel'), p.name).then(name => {
            if (name) app2.projectRename(p.id, name);
          });
        } },
        { label: S.t('projectRemove'), danger: true, run: () => {
          void confirmDialog(S.t('projectRemove'), S.t('projectRemoveConfirm', { name: p.name }), S.t('projectRemove'), true)
            .then(ok => { if (ok) app2.projectRemove(p.id); });
        } },
        { sep: true },
        { label: S.t('copyPath'), run: () => app2.copy(p.path) },
      ], e.clientX, e.clientY);
    });
    return item;
  }

  /** ＋ 菜单：保存当前工作区（多根工作区逐个列出）/ 浏览任意文件夹 */
  function showProjectAddMenu(x: number, y: number): void {
    const items: Parameters<typeof showContextMenu>[0] = [];
    const saved = new Set(S.projects.map(p => p.path.toLowerCase()));
    const folders = S.workspaceFolders.filter(f => !saved.has(f.toLowerCase()));
    if (folders.length) {
      for (const f of folders) {
        items.push({ label: `${S.t('projectAddCurrent')} — ${dirBase(f)}`, run: () => askProjectName(f) });
      }
    } else {
      items.push({ label: S.t('projectAddCurrent'), disabled: true });
    }
    items.push(
      { sep: true },
      { label: S.t('projectBrowse'), run: () => {
        void app.projectPickFolder().then(p => { if (p) askProjectName(p); });
      } },
    );
    showContextMenu(items, x, y);
  }

  function askProjectName(dir: string): void {
    const def = dirBase(dir) || dir;
    void promptDialog(S.t('projectAdd'), S.t('projectNameLabel'), def).then(name => {
      if (name !== null) app.projectAdd(dir, name || def);
    });
  }

  return { el: root, update };
}
