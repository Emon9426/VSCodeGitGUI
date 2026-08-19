/**
 * GitGraph 扩展入口。
 */
import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';
import { ReposTreeProvider } from './webview/reposTree';

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ReposTreeProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('gitgraph.repos', tree),
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
