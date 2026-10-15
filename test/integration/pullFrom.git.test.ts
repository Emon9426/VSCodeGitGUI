/**
 * 跨分支拉取集成测试（Issue #112，GITGRAPH_SMOKE=1 启用）：
 * 显式 refspec 的 pull——本地源 `git pull . <branch>`（等价 merge 本地 ref）与
 * 远端源 `git pull <remote> <branch>`（fetch+merge 远端最新），覆盖 merge/ff-only/rebase
 * 策略、fast-forward、Already up to date、autostash 与远端跟踪引用更新。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { OpRunner } from '../../src/ops/runner';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('跨分支拉取（Issue #112）', () => {
  const exec = new GitExecutor('git');
  const bases: string[] = [];
  const runner = new OpRunner(exec);

  afterAll(() => {
    for (const b of bases) { try { fs.rmSync(b, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  });

  /** 裸远端 + 工作克隆：main=c1；dev=c1+c2；main 再 +c3（与 dev 分叉） */
  async function mkRepo(diverge = true): Promise<{ W: string; remote: string }> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-pull112-'));
    bases.push(base);
    const remote = path.join(base, 'remote.git');
    const W = path.join(base, 'W');
    await exec.exec(base, ['init', '--bare', '--initial-branch=main', remote]);
    await exec.exec(base, ['clone', remote, W]);
    await exec.exec(W, ['config', 'user.name', 'UserA']);
    await exec.exec(W, ['config', 'user.email', 'a@t.cn']);
    await exec.exec(W, ['commit', '--allow-empty', '-m', 'c1 init']);
    await exec.exec(W, ['push', 'origin', 'main']);
    await exec.exec(W, ['checkout', '-b', 'dev']);
    await exec.exec(W, ['commit', '--allow-empty', '-m', 'c2 dev work']);
    // 收尾回到 main（diverge=false 的快进场景同样要停在 main，否则 pull . dev 拉自己=up-to-date）
    await exec.exec(W, ['checkout', 'main']);
    if (diverge) {
      await exec.exec(W, ['commit', '--allow-empty', '-m', 'c3 main work']);
    }
    return { W, remote };
  }

  const subject = async (root: string, ref = 'HEAD'): Promise<string> =>
    (await exec.exec(root, ['log', '-1', '--pretty=%s', ref])).stdout.trim();
  const parentCount = async (root: string): Promise<number> =>
    (await exec.exec(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.trim().split(' ').length - 1;

  it('本地源（. dev）分叉合并：生成双亲合并提交，双方提交都在 HEAD 历史内', async () => {
    const { W } = await mkRepo();
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'merge' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    expect(await parentCount(W)).toBe(2);
    const hist = (await exec.exec(W, ['log', '--pretty=%s'])).stdout;
    expect(hist).toContain('c2 dev work');
    expect(hist).toContain('c3 main work');
  }, 30_000);

  it('本地源快进：main 无自有提交时 pull . dev 直接 fast-forward 到源 tip', async () => {
    const { W } = await mkRepo(false);
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'merge' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    expect(out.stdoutTail ?? '').toMatch(/Fast-forward/);
    expect(await subject(W)).toBe('c2 dev work');
    expect(await parentCount(W)).toBe(1);
  }, 30_000);

  it('本地源已是最新：源为 HEAD 祖先时 no-op 成功（Already up to date）', async () => {
    const { W } = await mkRepo();
    await exec.exec(W, ['merge', '--no-edit', 'dev']);
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'merge' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    expect(/already up to date/i.test(out.stdoutTail ?? '')).toBe(true);
  }, 30_000);

  it('远端源（origin dev）：fetch+merge 远端最新，并更新远端跟踪引用', async () => {
    const { W, remote } = await mkRepo();
    // dev 推远端后远端再前进一步（模拟他人在 dev 上的新提交）：W 只知旧 dev
    await exec.exec(W, ['push', 'origin', 'dev']);
    const other = path.join(path.dirname(W), 'other');
    await exec.exec(path.dirname(W), ['clone', remote, other]);
    await exec.exec(other, ['config', 'user.name', 'UserB']);
    await exec.exec(other, ['config', 'user.email', 'b@t.cn']);
    await exec.exec(other, ['checkout', 'dev']);
    await exec.exec(other, ['commit', '--allow-empty', '-m', 'c4 remote dev tip']);
    await exec.exec(other, ['push', 'origin', 'dev']);

    const out = await runner.run(W, { kind: 'pull', remote: 'origin', branch: 'dev', strategy: 'merge' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    const hist = (await exec.exec(W, ['log', '--pretty=%s'])).stdout;
    expect(hist).toContain('c4 remote dev tip');   // 远端源的最新 tip（非本地旧 dev 的 c2）
    const track = (await exec.exec(W, ['rev-parse', 'refs/remotes/origin/dev'])).stdout.trim();
    const remoteTip = (await exec.exec(other, ['rev-parse', 'dev'])).stdout.trim();
    expect(track).toBe(remoteTip);                  // 跟踪引用随 fetch 更新
  }, 30_000);

  it('ff-only 策略：分叉时拒绝（非快进不可合并），退出非零', async () => {
    const { W } = await mkRepo();
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'ff-only' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(false);
    expect(await subject(W)).toBe('c3 main work');   // HEAD 未动
  }, 30_000);

  it('rebase 策略：分叉时变基到源之上，历史线性且源 tip 为 HEAD 祖先', async () => {
    const { W } = await mkRepo();
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'rebase' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    expect(await subject(W)).toBe('c3 main work');   // 本地提交重放在源 tip 之上
    // exec 非零退出=抛 GitError：不抛即「dev 是 HEAD 祖先」（#112 verify 意图成立）
    await expect(exec.exec(W, ['merge-base', '--is-ancestor', 'dev', 'HEAD'])).resolves.toBeDefined();
  }, 30_000);

  it('autostash：rebase 被未提交修改拒绝时，--autostash 贮藏后一步完成且修改保留', async () => {
    const { W } = await mkRepo(false);
    // main 上新增受跟踪文件 a.txt（dev 不触碰）→ 制造「挡道」脏文件：
    // merge 只挡会被合并触碰的文件，rebase 对任何受跟踪修改都要求干净工作区——确定性场景
    fs.writeFileSync(path.join(W, 'a.txt'), 'base');
    await exec.exec(W, ['add', 'a.txt']);
    await exec.exec(W, ['commit', '-m', 'c0 add a.txt']);
    fs.writeFileSync(path.join(W, 'a.txt'), 'local dirty');
    const refuse = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'rebase' }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(refuse.ok).toBe(false);
    const out = await runner.run(W, { kind: 'pull', remote: '.', branch: 'dev', strategy: 'rebase', autostash: true }, 1, () => undefined, ok => ok ? 'ok' : 'fail');
    expect(out.ok).toBe(true);
    expect(fs.readFileSync(path.join(W, 'a.txt'), 'utf8')).toBe('local dirty');   // 贮藏 pop 还原
  }, 30_000);
});
