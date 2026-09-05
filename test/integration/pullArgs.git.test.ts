/**
 * Pull 参数修复集成测试（Issue #6，GITGRAPH_SMOKE=1 启用）：
 * 真实仓库构造"本地分支名 ≠ 上游分支名"（本地 master 跟踪 origin/main，远端另有陈旧同名 master），
 * 验证修复后的无参 pull 按 branch.<name>.merge 正确拉到 main 的新提交
 * （修复前显式传本地分支名的 `git pull origin master` 会假成功 "Already up to date."，
 * 复现脚本见调查轮 %TEMP%/gitboard-issue6/repro2.sh）。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { OpRunner } from '../../src/ops/runner';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('Pull 分支配置语义（Issue #6）', () => {
  const exec = new GitExecutor('git');
  const bases: string[] = [];

  afterAll(() => {
    for (const b of bases) { try { fs.rmSync(b, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  });

  /** 双克隆夹具：A 推初始提交与陈旧 master；B 本地名 renameTo、上游固定 origin/main；A 再推 Day-T 提交 */
  async function mkPair(renameTo?: string): Promise<{ A: string; B: string }> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-pull6-'));
    bases.push(base);
    const remote = path.join(base, 'remote.git');
    const A = path.join(base, 'A');
    const B = path.join(base, 'B');
    await exec.exec(base, ['init', '--bare', '--initial-branch=main', remote]);
    await exec.exec(base, ['clone', remote, A]);
    await exec.exec(base, ['clone', remote, B]);
    for (const r of [A, B]) {
      await exec.exec(r, ['config', 'user.name', 'UserA']);
      await exec.exec(r, ['config', 'user.email', 'a@t.cn']);
    }
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'c1 init']);
    await exec.exec(A, ['push', 'origin', 'main:refs/heads/main']);
    await exec.exec(A, ['push', 'origin', 'main:refs/heads/master']);   // 远端陈旧同名 master（不再更新）
    // B：确定分支名（空仓库克隆的默认名随 git 版本/配置漂移）→ 对齐 main → 按需改名并显式设上游
    await exec.exec(B, ['checkout', '-b', 'main']);
    await exec.exec(B, ['pull', 'origin', 'main']);
    if (renameTo) {
      await exec.exec(B, ['branch', '-m', 'main', renameTo]);
      await exec.exec(B, ['branch', '--set-upstream-to=origin/main', renameTo]);
    } else {
      await exec.exec(B, ['branch', '--set-upstream-to=origin/main', 'main']);
    }
    // A：Day-T 新提交只推 main
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'c2 day-t feature']);
    await exec.exec(A, ['push', 'origin', 'main']);
    return { A, B };
  }

  it('本地名≠上游名：无参 pull 按分支级配置拉上游分支，不再假成功', async () => {
    const { B } = await mkPair('master');
    const upstream = (await exec.exec(B, ['rev-parse', '--abbrev-ref', 'master@{upstream}'])).stdout.trim();
    expect(upstream).toBe('origin/main');   // 场景前提：本地 master 跟踪 origin/main

    const runner = new OpRunner(exec);
    const outcome = await runner.run(B, { kind: 'pull', strategy: 'merge' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(outcome.ok).toBe(true);
    expect(/already up to date/i.test(outcome.stdoutTail ?? '')).toBe(false);   // 修复前的假成功形态必须消失
    expect(outcome.stdoutTail ?? '').toMatch(/Fast-forward/);

    const head = (await exec.exec(B, ['log', '-1', '--pretty=%s'])).stdout.trim();
    expect(head).toBe('c2 day-t feature');
  }, 30_000);

  it('回归：分支名一致场景无参 pull 正常 fast-forward（基线行为不变）', async () => {
    const { B } = await mkPair();
    const runner = new OpRunner(exec);
    const outcome = await runner.run(B, { kind: 'pull' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(outcome.ok).toBe(true);
    expect(outcome.stdoutTail ?? '').toMatch(/Fast-forward/);
    const head = (await exec.exec(B, ['log', '-1', '--pretty=%s'])).stdout.trim();
    expect(head).toBe('c2 day-t feature');
  }, 30_000);
});
