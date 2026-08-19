/**
 * gitboard: 只读文档提供者（设计方案 7.1）—— 复用 VS Code 内置差异编辑器。
 * URI 格式：gitboard://<repoId>/<encodeURIComponent(fileName)>?ref=<ref>&path=<repo 相对路径>
 * 文件名放在 path 段以获得 languageId 推断（语法高亮）。
 */
import * as vscode from 'vscode';
import type { GitService } from '../git/service';

export const GITBOARD_SCHEME = 'gitboard';
export const EMPTY_REF = '__empty__';

export function gitboardUri(repoId: string, fileName: string, ref: string, path: string): vscode.Uri {
  const enc = encodeURIComponent;
  return vscode.Uri.parse(
    `${GITBOARD_SCHEME}://${repoId}/${enc(fileName)}?ref=${enc(ref)}&path=${enc(path)}`,
  );
}

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly service: () => GitService | undefined,
    private readonly roots: Map<string, string>,
  ) {}

  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const svc = this.service();
    const root = this.roots.get(uri.authority);
    if (!svc || !root) return '';
    const q = new URLSearchParams(uri.query);
    const ref = q.get('ref') ?? '';
    const filePath = q.get('path') ?? '';
    if (!ref || !filePath || ref === EMPTY_REF) return '';
    return svc.contentAt(root, ref, filePath);
  }
}
