/**
 * OpVerifier 探针集成测试（Issue #6 后续，GITGRAPH_SMOKE=1 启用）：
 * 真实仓库验证各操作退出码 0 后的意图核对——pull 落后 / push 未达（#14 推错分支特征）/
 * commit HEAD 前进 / checkout/reset HEAD 匹配 / 标签存在性 / deep 档远端漂移与并行推送不误报。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { OpVerifier } from '../../src/ops/verify';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('操作后快速校验（Issue #6 后续）', () => {
  const exec = new GitExecutor('git');
  const verifier = new OpVerifier(exec);
  const bases: string[] = [];

  afterAll(() => {
    for (const b of bases) { try { fs.rmSync(b, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
  });

  /** bare 远端 + A/B 双克隆；A 负责制造远端变化，B 是被校验的"用户"仓库 */
  async function mkPair(): Promise<{ A: string; B: string }> {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-verify-'));
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
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'c1']);
    await exec.exec(A, ['push', 'origin', 'main']);
    await exec.exec(B, ['checkout', '-b', 'main']);
    await exec.exec(B, ['pull', 'origin', 'main']);
    await exec.exec(B, ['branch', '--set-upstream-to=origin/main', 'main']);
    return { A, B };
  }

  const headOf = async (root: string): Promise<string> => (await exec.exec(root, ['rev-parse', 'HEAD'])).stdout.trim();

  it('pull：同步状态 pass；落后状态 warn(behind)', async () => {
    const { A, B } = await mkPair();
    // A 追加一代并让 B 拉齐（保证 B 历史足够回退）
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'c2']);
    await exec.exec(A, ['push', 'origin', 'main']);
    await exec.exec(B, ['pull', 'origin', 'main']);
    // 同步：无变化 → pass
    const ok = await verifier.verify(B, { kind: 'pull' }, {}, 'quick');
    expect(ok.verdict).toBe('pass');
    expect(ok.ref).toBe('origin/main');
    // 落后：本地回退一代（模拟"退出码 0 但未合并上游"）
    await exec.exec(B, ['reset', '--hard', 'HEAD~1']);
    const warn = await verifier.verify(B, { kind: 'pull' }, {}, 'quick');
    expect(warn.verdict).toBe('warn');
    expect(warn.reason).toBe('behind');
    expect(warn.n).toBe(1);
  }, 30_000);

  it('push：已推送 pass；#14 场景（本地名≠上游名，推同名远端旧分支）warn(ahead)', async () => {
    const { A, B } = await mkPair();
    // 正常推送：本地领先一代并推到上游 → pass
    await exec.exec(B, ['commit', '--allow-empty', '-m', 'b1']);
    await exec.exec(B, ['push', 'origin', 'main']);
    const ok = await verifier.verify(B, { kind: 'push' }, {}, 'quick');
    expect(ok.verdict).toBe('pass');

    // #14 检测场景：远端建陈旧同名 master；B 本地改名 master（上游仍 origin/main），
    // 推 HEAD（GitBoard 现行为=推到远端同名 master）→ 对 origin/main 仍 ahead → warn
    await exec.exec(A, ['push', 'origin', 'main:refs/heads/master']);
    await exec.exec(B, ['commit', '--allow-empty', '-m', 'b2']);
    await exec.exec(B, ['branch', '-m', 'main', 'master']);
    await exec.exec(B, ['push', 'origin', 'HEAD:refs/heads/master']);
    const warn = await verifier.verify(B, { kind: 'push' }, {}, 'quick');
    expect(warn.verdict).toBe('warn');
    expect(warn.reason).toBe('ahead');
    expect(warn.n).toBe(1);   // b1 已在 origin/main，仅 b2 推去了远端 master
    expect(warn.ref).toBe('origin/main');
  }, 30_000);

  it('commit：HEAD 前进 pass；未变化 warn(headUnchanged)', async () => {
    const { B } = await mkPair();
    const before = await headOf(B);
    await exec.exec(B, ['commit', '--allow-empty', '-m', 'c9']);
    const r = await verifier.verify(B, { kind: 'commit' }, { headBefore: before }, 'quick');
    expect(r.verdict).toBe('pass');
    const unchanged = await verifier.verify(B, { kind: 'commit' }, { headBefore: await headOf(B) }, 'quick');
    expect(unchanged.verdict).toBe('warn');
    expect(unchanged.reason).toBe('headUnchanged');
  }, 30_000);

  it('checkout/reset：HEAD 与目标匹配 pass', async () => {
    const { B } = await mkPair();
    await exec.exec(B, ['checkout', '-b', 'feat']);
    const r1 = await verifier.verify(B, { kind: 'checkout', ref: 'feat' }, {}, 'quick');
    expect(r1.verdict).toBe('pass');
    const sha = await headOf(B);
    await exec.exec(B, ['reset', '--hard', sha]);
    const r3 = await verifier.verify(B, { kind: 'reset', sha }, {}, 'quick');
    expect(r3.verdict).toBe('pass');
    expect((await headOf(B))).toBe(sha);
  }, 30_000);

  it('tagCreate/tagDelete：存在性核对 pass', async () => {
    const { B } = await mkPair();
    await exec.exec(B, ['tag', 'v1']);
    expect((await verifier.verify(B, { kind: 'tagCreate', name: 'v1' }, {}, 'quick')).verdict).toBe('pass');
    await exec.exec(B, ['tag', '-d', 'v1']);
    expect((await verifier.verify(B, { kind: 'tagDelete', name: 'v1' }, {}, 'quick')).verdict).toBe('pass');
    // tagPush/tagDeleteRemote/fetch：quick 档跳过
    expect((await verifier.verify(B, { kind: 'tagPush', name: 'v1' }, {}, 'quick')).verdict).toBe('skip');
    expect((await verifier.verify(B, { kind: 'fetch', all: true }, {}, 'quick')).verdict).toBe('skip');
  }, 30_000);

  it('deep：远端漂移 warn；并行推送（远端前进但包含本地）不误报', async () => {
    const { A, B } = await mkPair();
    // B 未 fetch，A 推新提交 → B 的跟踪引用陈旧 → pull deep 检出漂移
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'a2']);
    await exec.exec(A, ['push', 'origin', 'main']);
    const drift = await verifier.verify(B, { kind: 'pull' }, {}, 'deep');
    expect(drift.verdict).toBe('warn');
    expect(drift.reason).toBe('remoteDrift');
    expect(drift.ref).toBe('origin/main');

    // push deep：B 正常推送后，A 追加推进（远端前进但 B 未 fetch，远端对象本地不可知）→
    // 无法判包含 → 诚实降级 unknown（不误报）；B fetch 后远端对象可知且包含本地 HEAD → pass
    await exec.exec(B, ['pull', 'origin', 'main']);
    await exec.exec(B, ['commit', '--allow-empty', '-m', 'b3']);
    await exec.exec(B, ['push', 'origin', 'main']);
    await exec.exec(A, ['pull', 'origin', 'main']);
    await exec.exec(A, ['commit', '--allow-empty', '-m', 'a3']);
    await exec.exec(A, ['push', 'origin', 'main']);
    const parallel = await verifier.verify(B, { kind: 'push' }, {}, 'deep');
    expect(parallel.verdict).toBe('unknown');
    await exec.exec(B, ['fetch', 'origin']);
    const parallel2 = await verifier.verify(B, { kind: 'push' }, {}, 'deep');
    expect(parallel2.verdict).toBe('pass');

    // push deep 漂移：远端被 force 改写不再包含本地 HEAD → warn
    await exec.exec(A, ['reset', '--hard', 'HEAD~2']);
    await exec.exec(A, ['push', '--force', 'origin', 'main']);
    const rewrite = await verifier.verify(B, { kind: 'push' }, {}, 'deep');
    expect(rewrite.verdict).toBe('warn');
    expect(rewrite.reason).toBe('remoteDrift');
  }, 60_000);

  it('detached HEAD：pull/push 校验跳过（skip）', async () => {
    const { B } = await mkPair();
    const sha = await headOf(B);
    await exec.exec(B, ['checkout', '--detach', sha]);
    expect((await verifier.verify(B, { kind: 'pull' }, {}, 'quick')).verdict).toBe('skip');
    expect((await verifier.verify(B, { kind: 'push' }, {}, 'deep')).verdict).toBe('skip');
  }, 30_000);
});
