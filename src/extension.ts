/**
 * GitGraph 扩展入口。
 */
import * as vscode from 'vscode';
import { GraphPanel } from './webview/panel';

export function activate(context: vscode.ExtensionContext): void {
  const open = () => GraphPanel.show(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('gitgraph.open', open),
    vscode.commands.registerCommand('gitgraph.fetch', () => GraphPanel.show(context).quickOp('fetch')),
    vscode.commands.registerCommand('gitgraph.pull', () => GraphPanel.show(context).quickOp('pull')),
    vscode.commands.registerCommand('gitgraph.push', () => GraphPanel.show(context).quickOp('push')),
  );
}

export function deactivate(): void { /* 资源由 subscriptions 管理 */ }
