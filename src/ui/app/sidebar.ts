/**
 * 左侧边栏（设计方案 4.2）：工程区（v0.11 跨工作区切换）、仓库区、分支区（v0.23.2 递归多级前缀分组：
 * 一级 本地/远程·<remote>，前缀组按 "/" 逐段嵌套，缩进逐级递增——Issue #24 二轮重设计）、标签。
 * 单击分支 = 过滤提交图；双击 = 检出；右键 = 操作菜单。
 * 工程区：双击在当前窗口打开工程；右键可新窗口打开/重命名/移除。
 */
import type { BranchInfo } from '../../common/models';
import { S, type App } from '../state';
import { el, clearChildren } from '../util';
import { buildPrefixTree, countNode, stripTo, type PrefixNode } from './branchGroup';
import { openBranchPicker } from './branchPicker';
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
  const tagSec = section(S.t('tags'));
  root.append(projSec.box, repoSec.box, branchSec.box, tagSec.box);

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
    // 分支区（Issue #24 二轮重设计）：两级分组——一级 本地 / 远程·<remote>，二级 / 前缀（配置可关则平铺）
    const strip = (n: string) => (n.includes('/') ? n.slice(n.indexOf('/') + 1) : n);
    const remoteTotal = st?.remotes.reduce((n, g) => n + g.branches.length, 0) ?? 0;
    sectionTitle(branchSec, `${S.t('branches')} (${(st?.branches.length ?? 0) + remoteTotal})`);
    // 分支区标题旁 ➕：检出/新建分支（Issue #24 三轮；sectionTitle 的 textContent 会清标题子元素，须每轮补挂）
    let branchAdd = branchSec.box.querySelector('.gg-side-add') as HTMLElement | null;
    if (!branchAdd) {
      branchAdd = el('button', 'gg-side-add', '＋');
      branchAdd.addEventListener('click', e => {
        e.stopPropagation();
        openBranchPicker(app, 'checkout');
      });
      branchSec.box.firstElementChild!.appendChild(branchAdd);
    }
    branchAdd.title = S.t('branchAddTip');
    clearChildren(branchSec.list);
    if (st) {
      // ---- 一级：本地（HEAD 分支恒置顶，buildRefTree 已排序）----
      branchSec.list.appendChild(collapseGroup('top:local', `⑂ ${S.t('pickerLocals')}`, st.branches.length, box => {
        if (S.config.branchGroupByPrefix) {
          // 递归多级前缀分组（v0.23.2）：组内行显示剥前缀短名，缩进逐级递增
          const { top, root } = buildPrefixTree(st.branches, b => b.name);
          for (const b of top) box.appendChild(branchRow(b, 0));
          renderPrefixTree(box, root, 'local', 0, b => b.name, (b, depth, disp) => branchRow(b, depth, disp));
        } else {
          for (const b of st.branches) box.appendChild(branchRow(b, 0));
        }
      }, 1));
      // ---- 一级：远程（每 remote 一组；右键 fetch 菜单保留）----
      for (const g of st.remotes) {
        branchSec.list.appendChild(collapseGroup('top:remote:' + g.name, `⇅ ${S.t('pickerRemotes')} · ${g.name}`, g.branches.length, box => {
          if (S.config.branchGroupByPrefix) {
            // 远程分支剥 remote 名后按前缀分组；组内行显示剥 remote 名与前缀的短名（操作仍用全名）
            const { top, root } = buildPrefixTree(g.branches, b => strip(b.name));
            for (const b of top) box.appendChild(remoteRow(b, g.name, 0, strip(b.name)));
            renderPrefixTree(box, root, 'remote:' + g.name, 0, b => strip(b.name), (b, depth, disp) => remoteRow(b, g.name, depth, disp));
          } else {
            for (const b of g.branches) box.appendChild(remoteRow(b, g.name, 0, strip(b.name)));
          }
        }, 1, e => {
          e.preventDefault();
          showContextMenu([
            { label: S.t('fetchAll'), run: () => app.runFetch() },
          ], e.clientX, e.clientY);
        }));
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

  /** 折叠组（Issue #24 二轮；v0.23.2 递归多级）：一级（本地 / 远程·<remote>）与前缀组（任意深度）共用骨架；
   *  缩进：level 1 基准 12px，level ≥2 组头 = 26 + (level-2)×16px（CSS 变量 --k）；
   *  折叠集合经宿主 globalState 跨会话保持（key 含完整前缀路径，旧一级 key 天然兼容） */
  function collapseGroup(
    key: string, label: string, count: number, renderItems: (into: HTMLElement) => void,
    level: number = 2, onContextMenu?: (e: MouseEvent) => void,
  ): HTMLElement {
    const box = el('div', 'gg-side-group');
    const collapsed = S.branchGroupsCollapsed.has(key);
    const head = el('div', `gg-side-item group pgroup${level === 1 ? ' l1' : ''}`);
    if (level > 1) head.style.setProperty('--k', String(level - 2));
    head.appendChild(el('span', 'gg-side-caret', collapsed ? '▸' : '▾'));
    head.appendChild(el('span', 'gg-side-name', label));
    head.appendChild(el('span', 'gg-side-count', String(count)));
    head.title = `${label} (${count})`;
    head.addEventListener('click', () => app.toggleBranchGroup(key));
    if (onContextMenu) head.addEventListener('contextmenu', onContextMenu);
    box.appendChild(head);
    if (!collapsed) renderItems(box);
    return box;
  }

  /** 前缀组树递归渲染（v0.23.2）：node.items 直挂（depth 随层级递增），children 逐级 collapseGroup；
   *  初始 root 以 depth=0 调用 → 一级前缀组头 level 2（26px）、其组内行 depth 1（44px），每深一级 +16px。
   *  nameOf = 建树所用名（远程为剥 remote 名），短名据此剥离 */
  function renderPrefixTree(
    into: HTMLElement, node: PrefixNode<BranchInfo>, keyBase: string, depth: number,
    nameOf: (b: BranchInfo) => string,
    rowOf: (b: BranchInfo, depth: number, display: string) => HTMLElement,
  ): void {
    for (const b of node.items) into.appendChild(rowOf(b, depth, stripTo(node.path, nameOf(b))));
    for (const ch of node.children) {
      into.appendChild(collapseGroup(`${keyBase}:${ch.path}`, `${ch.seg}/`, countNode(ch), box =>
        renderPrefixTree(box, ch, keyBase, depth + 1, nameOf, rowOf), depth + 2));
    }
  }

  function branchRow(b: BranchInfo, depth: number, display?: string): HTMLElement {
    const item = el('div', `gg-side-item branch${b.isHead ? ' head' : ''}${S.state?.filterRef === b.fullName ? ' filtered' : ''}`);
    item.style.setProperty('--d', String(depth));
    if (b.isHead) item.appendChild(el('span', 'gg-dot'));
    item.appendChild(el('span', 'gg-side-name', display ?? b.name));
    const badge = el('span', 'gg-ab');
    if (b.ahead) badge.appendChild(el('b', 'a', `↑${b.ahead}`));
    if (b.behind) badge.appendChild(el('b', 'd', `↓${b.behind}`));
    if (b.ahead || b.behind) item.appendChild(badge);
    // 未设上游（Issue #24）：本地独有、尚未推送
    if (!b.upstream && !b.isHead) item.appendChild(el('span', 'gg-side-flag', S.t('branchUnpushed')));
    item.title = b.subject ?? b.name;
    filterClick(item, b.fullName);
    item.addEventListener('dblclick', () => app.checkoutRef(b.name));
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu([
        { label: S.t('checkout'), run: () => app.checkoutRef(b.name) },
        { label: S.t('pullThis'), disabled: !b.upstream, run: () => app.runPull() },
        { label: S.t('pushThis'), run: () => app.runPush() },
        { sep: true },
        { label: S.t('copyBranchName'), run: () => app.copy(b.name) },
        { sep: true },
        // 删除本地分支（#39）：仅删本地；当前分支 git 硬限制不可删，禁用并说明
        ...(b.isHead
          ? [{ label: S.t('branchDeleteCurrent'), disabled: true }]
          : [{ label: S.t('branchDelete'), danger: true, run: () => {
            void confirmDialog(S.t('branchDelete'), S.t('branchDeleteConfirm', { name: b.name }), S.t('branchDelete'), true)
              .then(ok => { if (ok) app.branchDelete(b.name); });
          } }]),
      ], e.clientX, e.clientY);
    });
    return item;
  }

  function remoteRow(b: BranchInfo, group: string, depth: number, display?: string): HTMLElement {
    const item = el('div', `gg-side-item remote${S.state?.filterRef === b.fullName ? ' filtered' : ''}`);
    item.style.setProperty('--d', String(depth));
    item.appendChild(el('span', 'gg-side-name', display ?? b.name));
    // 本地已有同名分支（Issue #24）：远端影子指针标记，回答"哪个分支在远程、哪个在本地"
    const stripped = b.name.includes('/') ? b.name.slice(b.name.indexOf('/') + 1) : b.name;
    if (S.state?.branches.some(x => x.name === stripped)) item.appendChild(el('span', 'gg-side-flag', S.t('branchHasLocal')));
    item.title = b.subject ?? b.name;
    filterClick(item, b.fullName);
    item.addEventListener('dblclick', () => {
      const suggest = b.name.includes('/') ? b.name.split('/').slice(1).join('/') : b.name;
      app.checkoutRemoteAs(b.name, suggest);
    });
    item.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContextMenu([
        { label: S.t('checkoutAs'), run: () => {
          const suggest = b.name.includes('/') ? b.name.split('/').slice(1).join('/') : b.name;
          app.checkoutRemoteAs(b.name, suggest);
        } },
        { label: S.t('fetchRemote'), run: () => app.runFetch(group) },
        { sep: true },
        { label: S.t('copyBranchName'), run: () => app.copy(b.name) },
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
