/**
 * Issue #7 双队列单测：
 * 网络道挂起不堵本地道（根因修复）、onQueued 排队位次、laneBusy、
 * index.lock 撞锁单命令重试、本地道 FIFO 顺序。
 * 全部用 fake exec（不打真实 git）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { GitExecutor, GitError, type ExecResult } from '../../src/git/executor';
import { OpRunner, type OpSpec } from '../../src/ops/runner';

const ROOT = 'R:/repo';

function ok(): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, truncated: false };
}

function lockError(): GitError {
  return new GitError('E_GIT_EXIT', 'git add exited with 128', 128, 'git add',
    "fatal: Unable to create 'R:/repo/.git/index.lock': File exists.");
}

/** fake timers 下等待 op（含 400ms 撞锁退避）：推进足够时间再收结果 */
function settle<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return vi.advanceTimersByTimeAsync(ms).then(() => p);
}

describe('OpRunner 双队列（Issue #7）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('网络道挂起时本地道不受阻塞（根因：本地 op 永不排在网络 op 后面）', async () => {
    const exec = new GitExecutor('git');
    const spy = vi.spyOn(exec, 'exec').mockImplementation((_root, args) =>
      (args ?? []).includes('fetch') ? new Promise<ExecResult>(() => undefined) : Promise.resolve(ok()));
    const runner = new OpRunner(exec);
    const pFetch = runner.run(ROOT, { kind: 'fetch', all: true }, 1, () => undefined, () => 'F');
    await vi.advanceTimersByTimeAsync(20);   // fetch 已进入执行（挂起）
    expect(runner.laneBusy(ROOT, 'net')).toBe(true);
    expect(runner.laneBusy(ROOT, 'local')).toBe(false);

    const local = runner.run(ROOT, { kind: 'stage', paths: ['a.txt'] }, 2, () => undefined, () => 'S');
    const settled = await Promise.race([
      local.then(() => 'done'),
      vi.advanceTimersByTimeAsync(300).then(() => 'blocked'),
    ]);
    expect(settled).toBe('done');
    const out = await local;
    expect(out.ok).toBe(true);
    void pFetch;
    expect(spy).toHaveBeenCalled();
  });

  it('onQueued 位次：同道依次 0/1/2，且后入者等前序完成才 onStart（FIFO）', async () => {
    const exec = new GitExecutor('git');
    let releaseFirst: (r: ExecResult) => void = () => undefined;
    let n = 0;
    vi.spyOn(exec, 'exec').mockImplementation(() => {
      n++;
      return n === 1 ? new Promise<ExecResult>(r => { releaseFirst = r; }) : Promise.resolve(ok());
    });
    const runner = new OpRunner(exec);
    const positions: number[] = [];
    const started: number[] = [];
    const p1 = runner.run(ROOT, { kind: 'stage', paths: ['1'] }, 1, () => undefined, () => 'A',
      p => positions.push(p), () => started.push(1));
    await vi.advanceTimersByTimeAsync(5);
    const p2 = runner.run(ROOT, { kind: 'stage', paths: ['2'] }, 2, () => undefined, () => 'B',
      p => positions.push(p), () => started.push(2));
    const p3 = runner.run(ROOT, { kind: 'unstage', paths: ['3'] }, 3, () => undefined, () => 'C',
      p => positions.push(p), () => started.push(3));
    expect(positions).toEqual([0, 1, 2]);
    expect(started).toEqual([1]);          // FIFO：2/3 尚未开跑
    releaseFirst(ok());
    await Promise.all([p1, p2, p3]);
    expect(started).toEqual([1, 2, 3]);
  });

  it('index.lock 撞锁：单命令退避 400ms 重试一次成功，op 成功', async () => {
    const exec = new GitExecutor('git');
    let n = 0;
    const spy = vi.spyOn(exec, 'exec').mockImplementation(() => {
      n++;
      return n === 1 ? Promise.reject(lockError()) : Promise.resolve(ok());
    });
    const runner = new OpRunner(exec);
    const t0 = Date.now();
    const out = await settle(runner.run(ROOT, { kind: 'stage', paths: ['a'] }, 1, () => undefined, () => 'S'));
    expect(out.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);   // 同一条 add 恰好两次
    expect(Date.now() - t0).toBeGreaterThanOrEqual(390);   // 含 400ms 退避
  });

  it('index.lock 重试耗尽仍失败 → op 失败且只试两次；非撞锁错误不重试', async () => {
    const exec = new GitExecutor('git');
    const always = vi.fn(() => Promise.reject(lockError()));
    vi.spyOn(exec, 'exec').mockImplementation(always as unknown as () => Promise<ExecResult>);
    const runner = new OpRunner(exec);
    const out = await settle(runner.run(ROOT, { kind: 'stage', paths: ['a'] }, 1, () => undefined, () => 'S'));
    expect(out.ok).toBe(false);
    expect(always).toHaveBeenCalledTimes(2);

    const exec2 = new GitExecutor('git');
    const other = vi.fn(() => Promise.reject(new GitError('E_GIT_EXIT', 'boom', 128, 'git add', 'some other error')));
    vi.spyOn(exec2, 'exec').mockImplementation(other as unknown as () => Promise<ExecResult>);
    const runner2 = new OpRunner(exec2);
    const out2 = await settle(runner2.run(ROOT, { kind: 'stage', paths: ['a'] }, 1, () => undefined, () => 'S'));
    expect(out2.ok).toBe(false);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('命令序列粒度：checkout 成功后 add 撞锁，只重试 add（共 3 次 exec）', async () => {
    const exec = new GitExecutor('git');
    const calls: string[][] = [];
    let n = 0;
    vi.spyOn(exec, 'exec').mockImplementation((_r, args) => {
      n++;
      calls.push(args ?? []);
      return n === 2 ? Promise.reject(lockError()) : Promise.resolve(ok());
    });
    const runner = new OpRunner(exec);
    const out = await settle(runner.run(ROOT, { kind: 'resolveConflict', paths: ['f.txt'], ours: true }, 1, () => undefined, () => 'R'));
    expect(out.ok).toBe(true);
    expect(calls.filter(c => c.includes('checkout'))).toHaveLength(1);
    expect(calls.filter(c => c.includes('add'))).toHaveLength(2);
    expect(n).toBe(3);
  });

  it('网络 op 排队位次同样可见（fetch 挂起时 pull 排第 1）', async () => {
    const exec = new GitExecutor('git');
    vi.spyOn(exec, 'exec').mockImplementation(() => new Promise<ExecResult>(() => undefined));
    const runner = new OpRunner(exec);
    const positions: number[] = [];
    const p1 = runner.run(ROOT, { kind: 'fetch', all: true }, 1, () => undefined, () => 'F', p => positions.push(p));
    await vi.advanceTimersByTimeAsync(5);
    const p2 = runner.run(ROOT, { kind: 'pull' } as OpSpec, 2, () => undefined, () => 'P', p => positions.push(p));
    expect(positions).toEqual([0, 1]);
    void p1; void p2;
  });
});
