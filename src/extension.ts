/**
 * GitGraph 扩展入口。
 * 活动栏图标行为：视图可见（用户点击图标）时直接打开主界面并收起侧栏。
 */
import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';
import { ReposTreeProvider } from './webview/reposTree';

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ReposTreeProvider();
  const treeView = vscode.window.createTreeView('gitgraph.repos', { treeDataProvider: tree });

  context.subscriptions.push(
    treeView,
    treeView.onDidChangeVisibility(e => {
      if (!e.visible) return;
      GraphPanel.show(context);
      // 收起侧栏，让用户直接看到主界面（closeSidebar 不存在时退化为 toggle）
      void vscode.commands
        .executeCommand('workbench.action.closeSidebar')
        .then(undefined, () => vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'));
    }),
    vscode.commands.registerCommand('gitgraph.open', () => GraphPanel.show(context)),
    vscode.commands.registerCommand('gitgraph.openRepo', (repoId: string) => GraphPanel.show(context, repoId)),
    vscode.commands.registerCommand('gitgraph.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('gitgraph.fetch', () => GraphPanel.show(context).quickOp('fetch')),
    vscode.commands.registerCommand('gitgraph.pull', () => GraphPanel.show(context).quickOp('pull')),
    vscode.commands.registerCommand('gitgraph.push', () => GraphPanel.show(context).quickOp('push')),
    GraphPanel.onDidState(() => tree.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
  );
}

export function deactivate(): void { /* 资源由 subscriptions 管理 */ }
