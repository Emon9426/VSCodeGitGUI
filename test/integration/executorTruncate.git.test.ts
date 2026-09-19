/**
 * executor 输出截断语义集成测试（Issue #15；GITGRAPH_SMOKE=1 启用）：
 * stdout 超 maxBytes 时进程被中断，结果按「截断成功」返回（exitCode 0 + truncated=true），
 * 调用方可区分完整成功与输出截断成功；正常输出 truncated=false。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor, isGitError } from '../../src/git/executor';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

const GENV = {
  ...process.env,
  GIT_AUTHOR_NAME: '王五', GIT_AUTHOR_EMAIL: 'w@x.y',
  GIT_COMMITTER_NAME: '王五', GIT_COMMITTER_EMAIL: 'w@x.y',
};

function mkRepo(commits = 30): { root: string; ex: GitExecutor } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-trunc-'));
  const g = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, env: GENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${String(r.stderr)}`);
  };
  g('init', '-b', 'main');
  // 造足量输出：每轮变更文件内容（内容不变会 nothing to commit），log --format=%H%n%B 展开后远超测试用小 maxBytes
  for (let i = 0; i < commits; i++) {
    fs.writeFileSync(path.join(root, 'big.txt'), `${'x'.repeat(64)}\nr${i}\n`);
    g('add', '-A');
    g('commit', '-q', '-m', `c${i} ${'y'.repeat(200)}`);
  }
  return { root, ex: new GitExecutor('git') };
}

describe.skipIf(!enabled)('executor 截断语义（Issue #15）', () => {
  it('stdout 超上限：截断成功（exitCode 0 + truncated=true），stdout 不超上限', async () => {
    const { root, ex } = mkRepo();
    const r = await ex.exec(root, ['log', '--format=%H %s %b'], { maxBytes: 2 * 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(2 * 1024 + 64 * 1024);   // 上限 + 单 chunk 超调余量
  });

  it('正常输出：truncated=false', async () => {
    const { root, ex } = mkRepo();
    const r = await ex.exec(root, ['log', '--oneline'], { maxBytes: 1024 * 1024 });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.stdout).toContain('c29');
  });

  it('截断不误报为失败（E_GIT_EXIT 不应抛出）', async () => {
    const { root, ex } = mkRepo();
    let threw = false;
    try {
      await ex.exec(root, ['log', '--format=%H %s %b'], { maxBytes: 2 * 1024 });
    } catch (e) {
      threw = true;
      expect(isGitError(e)).toBe(false);
    }
    expect(threw).toBe(false);
  });

  // Issue #78：Node 对 execFile 强制默认 maxBuffer=1MB（超限 SIGTERM 杀子进程）——
  // 未抬高前，输出 >1MB 且 < maxBytes 的命令以 signal 失败而非成功。
  // 体量构造：format 字面量按提交数放大（40 × 30000B ≈ 1.2MB；单参数 <32767 字符防 CreateProcess 拒绝）
  it('输出 >1MB（默认 maxBytes 内）：成功返回且不截断（maxBuffer 兜底已抬高）', async () => {
    const { root, ex } = mkRepo(40);
    const r = await ex.exec(root, ['log', `--format=${'z'.repeat(30000)}%n`], {});
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(false);
    expect(r.stdout.length).toBeGreaterThan(1024 * 1024);
  });
});
