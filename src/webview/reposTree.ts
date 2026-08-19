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
}

export class ReposTreeProvider implements vscode.TreeDataProvider<RepoEntry> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private entries: RepoEntry[] = [];
  private executor?: GitExecutor;
  private loading = false;

  refresh(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      if (!this.executor) {
        const cfg = vscode.workspace.getConfiguration('gitmap');
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
          return { meta: m, branch: st.detached ? undefined : st.branch, detached: st.detached };
        } catch {
          return { meta: m };
        }
      }));
      this.entries = entries;
    } catch {
      this.entries = [];
    }
    this.loading = false;
    this.emitter.fire();
  }

  getTreeItem(entry: RepoEntry): vscode.TreeItem {
    const cfg = vscode.workspace.getConfiguration('gitmap');
    const t = createT(resolveLang(cfg.get('language', 'auto'), vscode.env.language));
    const item = new vscode.TreeItem(entry.meta.name, vscode.TreeItemCollapsibleState.None);
    item.description = entry.detached ? t('detachedHead') : entry.branch;
    item.tooltip = entry.meta.root;
    item.iconPath = new vscode.ThemeIcon('repo');
    item.command = { command: 'gitmap.openRepo', title: t('cmdOpenGraph'), arguments: [entry.meta.id] };
    return item;
  }

  getChildren(): RepoEntry[] {
    if (!this.entries.length && !this.loading) this.refresh();
    return this.entries;
  }
}
