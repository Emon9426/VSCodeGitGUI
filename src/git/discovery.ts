/**
 * 工作区仓库发现（设计方案 6.3）。
 */
import * as crypto from 'crypto';
import * as path from 'path';
import type { RepoMeta } from '../common/models';
import type { GitExecutor } from './executor';

export function repoIdOf(root: string): string {
  const norm = root.replace(/[\\/]+$/, '');
  return crypto.createHash('md5').update(norm).digest('hex').slice(0, 8);
}

export async function discoverRepos(executor: GitExecutor, workspaceFolders: readonly { uri: { fsPath: string } }[]): Promise<RepoMeta[]> {
  const repos = new Map<string, RepoMeta>();
  for (const folder of workspaceFolders) {
    try {
      const r = await executor.exec(folder.uri.fsPath, ['rev-parse', '--show-toplevel']);
      // git 返回正斜杠路径（D:/x/y）；统一规范为系统原生分隔符，
      // 否则后续 path.resolve 前缀比对（安全检查）会误判越界
      const root = path.resolve(r.stdout.trim());
      if (r.exitCode === 0 && root) {
        const id = repoIdOf(root);
        if (!repos.has(id)) repos.set(id, { id, name: path.basename(root), root });
      }
    } catch { /* 该文件夹不是 git 仓库 */ }
  }
  return [...repos.values()];
}
