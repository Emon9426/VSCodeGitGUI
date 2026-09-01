/**
 * 工作区仓库发现（设计方案 6.3）。
 */
import * as crypto from 'crypto';
import * as path from 'path';
import type { RepoMeta } from '../common/models';
import { GitExecutor } from './executor';

export function repoIdOf(root: string): string {
  const norm = root.replace(/[\\/]+$/, '');
  // 仅为路径生成稳定短 ID（globalState 持久化键），非加密用途；sha-256 取前 8 位十六进制
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 8);
}

export async function discoverRepos(executor: GitExecutor, workspaceFolders: readonly { uri: { fsPath: string } }[]): Promise<RepoMeta[]> {
  const repos = new Map<string, RepoMeta>();
  // 各文件夹并行探测（多根工作区不再串行等待；单个 spawn 慢时整体仍尽快返回）
  const found = await Promise.all(workspaceFolders.map(async folder => {
    try {
      const r = await executor.exec(folder.uri.fsPath, ['rev-parse', '--show-toplevel']);
      // git 返回正斜杠路径（D:/x/y）；统一规范为系统原生分隔符，
      // 否则后续 path.resolve 前缀比对（安全检查）会误判越界
      const root = path.resolve(r.stdout.trim());
      if (r.exitCode === 0 && root) {
        const id = repoIdOf(root);
        return { id, meta: { id, name: path.basename(root), root } as RepoMeta };
      }
    } catch { /* 该文件夹不是 git 仓库 */ }
    return undefined;
  }));
  for (const item of found) {
    if (item && !repos.has(item.id)) repos.set(item.id, item.meta);
  }
  return [...repos.values()];
}

/**
 * 共享 git 探测（v0.14.7）：活动栏树与主面板启动期共用一次 detect。
 * in-flight 去重（并发调用拿到同一 promise）+ 成功结果缓存（键=配置的 gitPath，
 * 配置变化自然失效重探）；失败不缓存，下次调用重试。
 */
let detectInflight: { key: string; p: Promise<GitExecutor> } | undefined;
let detectCached: { key: string; executor: GitExecutor } | undefined;

export function sharedDetect(configured: string, builtin: string | undefined): Promise<GitExecutor> {
  const key = configured || '';
  if (detectCached && detectCached.key === key) return Promise.resolve(detectCached.executor);
  if (detectInflight && detectInflight.key === key) return detectInflight.p;
  const p = GitExecutor.detect(configured, builtin).then(
    executor => {
      detectCached = { key, executor };
      detectInflight = undefined;
      return executor;
    },
    err => {
      detectInflight = undefined;   // 失败不缓存：下次重试
      throw err;
    },
  );
  detectInflight = { key, p };
  return p;
}
