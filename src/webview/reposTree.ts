/**
 * 活动栏侧栏视图：工作区仓库列表，点击仓库打开提交图。
 */
import * as vscode from 'vscode';
import { createT, resolveLang } from '../common/i18n';
import type { RepoMeta } from '../common/models';
import { GitExecutor } from '../git/executor';
import { discoverRepos } from '../git/discovery';
import { parseStatus } from '../git/parse';
import { builtinGitPath } from '../webview/panel';

interface RepoEntry {
  meta: RepoMeta;
  branch?: string;
  detached?: boolean;
  dirty?: number;   // 未提交改动文件数（含未跟踪/冲突），活动栏角标数据源
}

export class ReposTreeProvider implements vscode.TreeDataProvider<RepoEntry> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private entries: RepoEntry[] = [];
  private executor?: GitExecutor;
  private loading = false;
  private view?: vscode.TreeView<RepoEntry>;

  /** 注册 TreeView（设置活动栏角标用；extension.ts 在 createTreeView 后回填） */
  bindView(view: vscode.TreeView<RepoEntry>): void {
    this.view = view;
  }

  refresh(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (!this.executor) {
        const cfg = vscode.workspace.getConfiguration('gitboard');
        this.executor = await GitExecutor.detect(
          cfg.get<string>('gitPath', '') || '',
          builtinGitPath(),
        );
      }
      const metas = await discoverRepos(this.executor, vscode.workspace.workspaceFolders ?? []);
      const entries = await Promise.all(metas.map(async (m): Promise<RepoEntry> => {
        try {
          const r = await this.executor!.exec(m.root, ['status', '--porcelain=v1', '-b']);
          const st = parseStatus(r.stdout);
          return { meta: m, branch: st.detached ? undefined : st.branch, detached: st.detached, dirty: st.dirtyCount };
        } catch {
          return { meta: m };
        }
      }));
      this.entries = entries;
    } catch {
      this.entries = [];
    }
    this.loading = false;
    // 活动栏图标角标：工作区全部仓库未提交改动文件总数（VS Code SCM 同语义）
    if (this.view) {
      const dirty = this.entries.reduce((s, e) => s + (e.dirty ?? 0), 0);
      if (dirty > 0) {
        const cfg = vscode.workspace.getConfiguration('gitboard');
        const t = createT(resolveLang(cfg.get('language', 'auto'), vscode.env.language));
        this.view.badge = { value: dirty, tooltip: t('dirtyCount', { n: dirty }) };
      } else {
        this.view.badge = undefined;
      }
    }
    this.emitter.fire();
  }

  getTreeItem(entry: RepoEntry): vscode.TreeItem {
    const cfg = vscode.workspace.getConfiguration('gitboard');
    const t = createT(resolveLang(cfg.get('language', 'auto'), vscode.env.language));
    const item = new vscode.TreeItem(entry.meta.name, vscode.TreeItemCollapsibleState.None);
    item.description = entry.detached ? t('detachedHead') : entry.branch;
    item.tooltip = entry.meta.root;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.command = { command: 'gitboard.openRepo', title: t('cmdOpenGraph'), arguments: [entry.meta.id] };
    return item;
  }

  getChildren(): RepoEntry[] {
    if (!this.entries.length && !this.loading) this.refresh();
    return this.entries;
  }
}
