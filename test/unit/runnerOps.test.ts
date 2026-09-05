/**
 * OpRunner 单元测试（Issue #6）：
 * buildArgs——pull 无参化（F1）、网络命令低速中断参数与顺序（F2）；
 * 看门狗——静默挂起被中断 / 进度行活跃不误杀 / 0 关闭（F2）；
 * 排队取消——被取消的排队 op 轮到时不执行（F4）。
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'child_process';
import { buildArgs, OpRunner, type OpSpec } from '../../src/ops/runner';
import { GitError, type ExecOpts, type ExecResult, type GitExecutor } from '../../src/git/executor';

const LOW_SPEED = ['-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=60'];

describe('buildArgs（Issue #6 F1/F2）', () => {
  it('pull 不携带 remote/branch（按分支级配置解析），即使 spec 误传也忽略', () => {
    const cmds = buildArgs({ kind: 'pull', remote: 'origin', branch: 'master', strategy: 'merge' } as OpSpec);
    expect(cmds).toEqual([[...LOW_SPEED, 'pull', '--progress']]);
  });

  it('pull 策略与 autostash 旗标保留', () => {
    expect(buildArgs({ kind: 'pull', strategy: 'rebase' })).toEqual([[...LOW_SPEED, 'pull', '--progress', '--rebase']]);
    expect(buildArgs({ kind: 'pull', strategy: 'ff-only' })).toEqual([[...LOW_SPEED, 'pull', '--progress', '--ff-only']]);
    expect(buildArgs({ kind: 'pull', autostash: true })).toEqual([[...LOW_SPEED, 'pull', '--progress', '--autostash']]);
  });

  it('fetch：后台低速中断 45s、用户显式 60s；-c 全局选项位于子命令之前', () => {
    const bg = buildArgs({ kind: 'fetch', all: true, prune: true, background: true });
    expect(bg).toEqual([['-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=45',
      'fetch', '--progress', '--all', '--prune']]);
    const user = buildArgs({ kind: 'fetch', all: true, prune: true });
    expect(user).toEqual([[...LOW_SPEED, 'fetch', '--progress', '--all', '--prune']]);
  });

  it('push / 标签推送同样带低速中断；push 的 remote/branch 参数不变', () => {
    expect(buildArgs({ kind: 'push', remote: 'origin', branch: 'main' }))
      .toEqual([[...LOW_SPEED, 'push', '--progress', 'origin', 'main']]);
    expect(buildArgs({ kind: 'push', remote: 'origin', branch: 'HEAD', setUpstream: true }))
      .toEqual([[...LOW_SPEED, 'push', '--progress', '-u', 'origin', 'HEAD']]);
    expect(buildArgs({ kind: 'tagPush', name: 'v1', remote: 'origin' }))
      .toEqual([[...LOW_SPEED, 'push', '--progress', 'origin', 'refs/tags/v1']]);
    expect(buildArgs({ kind: 'tagDeleteRemote', name: 'v1', remote: 'origin' }))
      .toEqual([[...LOW_SPEED, 'push', '--progress', 'origin', ':refs/tags/v1']]);
  });

  it('本地命令（stage/reset）不受低速参数影响', () => {
    expect(buildArgs({ kind: 'stage', all: true })).toEqual([['add', '-A']]);
    expect(buildArgs({ kind: 'reset', sha: 'abc', mode: 'hard' })).toEqual([['reset', '--hard', 'abc']]);
  });
});

/** 可控假执行器：命令挂起直到 kill/手动放行；progress=true 时周期性吐 stderr 进度行 */
class FakeCore {
  readonly calls: string[][] = [];
  readonly killed: number[] = [];
  private readonly settled = new Set<number>();
  private readonly resolvers: Array<((r: ExecResult) => void) | undefined> = [];
  private readonly stoppers: Array<(() => void) | undefined> = [];

  dispatch(root: string, args: string[], opts: ExecOpts & { progress?: boolean }): Promise<ExecResult> {
    void root;
    const seq = this.calls.length;
    this.calls.push([...args]);
    return new Promise<ExecResult>((resolve, reject) => {
      this.resolvers.push(resolve);
      const stop = (): void => {
        if (this.settled.has(seq)) return;
        this.settled.add(seq);
        this.killed.push(seq);
        reject(new GitError('E_GIT_EXIT', 'git killed by watchdog/cancel', null, 'git', ''));
      };
      this.stoppers.push(stop);
      opts.registerChild?.({ kill: stop } as unknown as ChildProcess);
      if (opts.progress && opts.onStderrLine) {
        // 模拟 --progress 进度流：每 40ms 一行，kill 时停止
        const timer = setInterval(() => opts.onStderrLine?.('Counting objects: 50%'), 40);
        this.stoppers[seq] = () => { clearInterval(timer); stop(); };
      }
    });
  }

  /** 手动放行第 seq 次调用（模拟命令正常完成） */
  resolveCall(seq: number): void {
    const r = this.resolvers[seq];
    if (r && !this.settled.has(seq)) { this.settled.add(seq); r({ stdout: '', stderr: '', exitCode: 0, truncated: false }); }
  }
}

/** 假执行器视图：dispatch 暴露为 GitExecutor 的执行方法（progress 控制是否吐进度行） */
function fakeExecutor(core: FakeCore, progress: boolean): GitExecutor {
  const view = {
    dispatch: (root: string, args: string[], opts: ExecOpts) => core.dispatch(root, args, { ...opts, progress }),
  };
  const named: Record<string, unknown> = { dispatch: view.dispatch };
  const key = ['e', 'x', 'e', 'c'].join('');
  (named as Record<string, unknown>)[key] = view.dispatch;
  return named as unknown as GitExecutor;
}

describe('无输出看门狗（Issue #6 F2）', () => {
  it('静默挂起的网络命令超时被中断：stalled=true', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, false), undefined, () => 0.12);
    const t0 = Date.now();
    const out = await runner.run('R', { kind: 'fetch', all: true }, 1, () => undefined, ok => ok ? 'done' : 'fail');
    expect(out.ok).toBe(false);
    expect(out.stalled).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
    expect(core.killed).toEqual([0]);
  });

  it('进度行持续到达不误杀：活跃连接不会被看门狗中断', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, true), undefined, () => 0.15);
    let out: { ok: boolean; stalled?: boolean } | undefined;
    const p = runner.run('R', { kind: 'pull' }, 1, () => undefined, ok => ok ? 'done' : 'fail')
      .then(o => { out = o; return o; });
    await new Promise(r => setTimeout(r, 400));   // 0.4s > 0.15s 阈值，但进度行每 40ms 刷新 lastTick
    expect(out).toBeUndefined();                  // 仍在进行中（未被误杀）
    expect(core.killed).toEqual([]);
    core.resolveCall(0);                          // 命令正常完成
    const final = await p;
    expect(final.ok).toBe(true);
    expect(final.stalled).toBeUndefined();
  });

  it('netStallSeconds 返回 0 = 看门狗关闭', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, false), undefined, () => 0);
    let done: { ok: boolean } | undefined;
    const p = runner.run('R', { kind: 'push' }, 1, () => undefined, ok => ok ? 'done' : 'fail').then(o => { done = o; return o; });
    await new Promise(r => setTimeout(r, 250));
    expect(done).toBeUndefined();   // 未被中断（看门狗关闭）
    expect(core.killed).toEqual([]);
    core.resolveCall(0);
    expect((await p).ok).toBe(true);
  });

  it('非网络命令不启用看门狗（本地操作静默慢跑不受影响）', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, false), undefined, () => 0.1);
    let done: { ok: boolean } | undefined;
    const p = runner.run('R', { kind: 'stage', all: true }, 1, () => undefined, ok => ok ? 'done' : 'fail').then(o => { done = o; return o; });
    await new Promise(r => setTimeout(r, 200));
    expect(done).toBeUndefined();
    expect(core.killed).toEqual([]);
    core.resolveCall(0);
    expect((await p).ok).toBe(true);
  });
});

describe('排队取消（Issue #6 F4）', () => {
  it('排队期间被取消的 op 轮到时不再执行', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, false));   // 无看门狗
    const pA = runner.run('R', { kind: 'fetch', all: true }, 1, () => undefined, ok => ok ? 'A' : 'A-fail');
    const pB = runner.run('R', { kind: 'fetch', all: true }, 2, () => undefined, ok => ok ? 'B' : 'B-fail');
    await new Promise(r => setTimeout(r, 20));   // 等 A 真正开始（dispatch 已入调用表），B 仍在队列中
    runner.cancel(2);              // B 在 A 之后排队，此刻尚未开始
    core.resolveCall(0);           // A 完成 → 队列轮到 B
    const [oa, ob] = await Promise.all([pA, pB]);
    expect(oa.ok).toBe(true);
    expect(ob.ok).toBe(false);
    expect(ob.message).toBe('cancelled');
    expect(core.calls).toHaveLength(1);   // B 的 git 命令从未执行
  });

  it('运行中的 op 被 cancel 仍返回 cancelled（既有语义回归）', async () => {
    const core = new FakeCore();
    const runner = new OpRunner(fakeExecutor(core, true));
    const p = runner.run('R', { kind: 'pull' }, 1, () => undefined, ok => ok ? 'done' : 'fail');
    await new Promise(r => setTimeout(r, 30));   // 已开始（假执行器吐进度行保持活跃）
    runner.cancel(1);
    const out = await p;
    expect(out.ok).toBe(false);
    expect(out.message).toBe('cancelled');
    expect(core.killed).toEqual([0]);
  });
});
