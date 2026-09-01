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

  // 快速笔记视图（v0.15）：占位树仅承载活动栏图标的可见性——点击图标直达笔记面板
  const notesStub = {
    onDidChangeTreeData: undefined,
    getTreeItem(): vscode.TreeItem { return new vscode.TreeItem(''); },
    getChildren(): vscode.TreeItem[] { return []; },
  };
  const notesView = vscode.window.createTreeView('gitboard.notesList', { treeDataProvider: notesStub });

  context.subscriptions.push(
    treeView,
    notesView,
    treeView.onDidChangeVisibility(e => {
      if (!e.visible) return;
      GraphPanel.show(context);
      // 收起侧栏，让用户直接看到主界面（closeSidebar 不存在时退化为 toggle）
      void vscode.commands
        .executeCommand('workbench.action.closeSidebar')
        .then(undefined, () => vscode.commands.executeCommand('workbench.action.toggleSidebarVisibility'));
    }),
    notesView.onDidChangeVisibility(e => {
      if (!e.visible) return;
      void vscode.commands.executeCommand('gitboard.notes');
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
    // 快速笔记（v0.15）：懒加载独立模块——零 git 依赖，首次打开才加载，Git 主路径零开销
    vscode.commands.registerCommand('gitboard.notes', () => {
      void import('./notes/NotesPanel').then(m => m.NotesPanel.open(context)).catch(err =>
        vscode.window.showErrorMessage(`GitBoard Notes: ${err?.message ?? err}`));
    }),
    vscode.commands.registerCommand('gitboard.notes.openHtml', (uri?: vscode.Uri) => {
      if (!uri?.fsPath) return;
      void import('./notes/NotesPanel').then(async m => {
        const ok = await m.NotesPanel.openHtml(context, uri.fsPath);
        if (!ok) void vscode.window.showInformationMessage('GitBoard: 该 HTML 不含 GitBoard 笔记数据');
      }).catch(err =>
        vscode.window.showErrorMessage(`GitBoard Notes: ${err?.message ?? err}`));
    }),
    GraphPanel.onDidState(() => tree.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
  );
}

export function deactivate(): void { /* 资源由 subscriptions 管理 */ }
