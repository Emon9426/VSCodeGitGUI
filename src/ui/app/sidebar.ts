/**
 * 左侧边栏（设计方案 4.2）：仓库区、本地分支（ahead/behind 徽标）、远程、标签。
 * 单击分支 = 过滤提交图；双击 = 检出；右键 = 操作菜单。
 */
import type { BranchInfo } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren } from '../util';
import { showContextMenu } from './overlays';

export interface Sidebar {
  el: HTMLElement;
  update(): void;
}

export function createSidebar(app: App): Sidebar {
  const root = el('div', 'gg-side');
  const repoSec = section(S.t('repos'));
  const branchSec = section(S.t('branches'));
  const remoteSec = section(S.t('remotes'));
  const tagSec = section(S.t('tags'));
  root.append(repoSec.box, branchSec.box, remoteSec.box, tagSec.box);

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
    // 仓库
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
      repoSec.list.appendChild(el('div', 'gg-side-empty', S.t('noRepos')));
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
    clearChildren(tagSec.list);
    if (st) {
      for (const tg of st.tags) {
        const item = el('div', 'gg-side-item tag');
        item.appendChild(el('span', 'gg-side-name', tg.name));
        filterClick(item, tg.name);
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

  return { el: root, update };
}
