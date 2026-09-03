/**
 * GitBoard 扩展入口。
 * 活动栏图标行为：视图可见（用户点击图标）时直接打开主界面并收起侧栏。
 */
import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';
import { ReposTreeProvider } from './webview/reposTree';

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ReposTreeProvider();
  const treeView = vscode.window.createTreeView('gitboard.repos', { treeDataProvider: tree });
  tree.bindView(treeView);   // 角标数据源：load 后设置活动栏图标未提交改动数

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
    vscode.commands.registerCommand('gitboard.open', () => GraphPanel.show(context)),
    vscode.commands.registerCommand('gitboard.openRepo', (repoId: string) => GraphPanel.show(context, repoId)),
    vscode.commands.registerCommand('gitboard.refreshTree', () => tree.refresh()),
    vscode.commands.registerCommand('gitboard.fetch', () => GraphPanel.show(context).quickOp('fetch')),
    vscode.commands.registerCommand('gitboard.pull', () => GraphPanel.show(context).quickOp('pull')),
    vscode.commands.registerCommand('gitboard.push', () => GraphPanel.show(context).quickOp('push')),
    vscode.commands.registerCommand('gitboard.commit', () => {
      const p = GraphPanel.show(context);
      p.openWorkView();
    }),
    vscode.commands.registerCommand('gitboard.setLanguage', () => {
      void GraphPanel.show(context).pickLanguage();
    }),
    // 文件历史页（v0.14）：资源管理器右键直达（定位该文件并显示历史）
    vscode.commands.registerCommand('gitboard.showFileHistory', (uri?: vscode.Uri) => {
      if (!uri || !uri.fsPath) return;
      GraphPanel.show(context).revealInFiles(uri.fsPath);
    }),
    GraphPanel.onDidState(() => tree.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
  );
}

export function deactivate(): void { /* 资源由 subscriptions 管理 */ }
