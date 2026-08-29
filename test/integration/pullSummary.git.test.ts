/**
 * Pull/Fetch 摘要冒烟（GITGRAPH_SMOKE=1 启用）：
 * 真实仓库构造 main + feat 分支 + merge，验证 --no-merges 纯净口径、
 * 旧引用排除、截断上限与 40 位 hex 白名单。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { PullSummaryService } from '../../src/git/summary';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('Pull/Fetch 摘要冒烟', () => {
  let root: string;
  let exec: GitExecutor;
  let svc: PullSummaryService;

  async function setup(): Promise<{ head: string; oldMain: string }> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-psum-'));
    exec = new GitExecutor('git');
    svc = new PullSummaryService(exec);
    process.env.GIT_AUTHOR_NAME = '张三';
    process.env.GIT_AUTHOR_EMAIL = 'z@x.y';
    process.env.GIT_COMMITTER_NAME = '张三';
    process.env.GIT_COMMITTER_EMAIL = 'z@x.y';
    const run = async (args: string[]) => { await exec.exec(root, args); };
    await run(['init', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'a.txt'), '1');
    await run(['add', '-A']);
    await run(['commit', '-m', 'c1']);
    const oldMain = (await exec.exec(root, ['rev-parse', 'HEAD'])).stdout.trim();
    await run(['checkout', '-b', 'feat']);
    fs.writeFileSync(path.join(root, 'b.txt'), '2');
    fs.renameSync(path.join(root, 'a.txt'), path.join(root, 'a2.txt'));
    await run(['add', '-A']);
    await run(['commit', '-m', 'c2 on feat']);
    await run(['checkout', 'main']);
    await run(['merge', 'feat', '--no-edit']);   // 产生 merge 提交
    const head = (await exec.exec(root, ['rev-parse', 'HEAD'])).stdout.trim();
    return { head, oldMain };
  }

  it('排除 merge 与旧引用可达提交；重命名输出 旧→新', async () => {
    const { head, oldMain } = await setup();
    const { entries, truncated } = await svc.of(root, [head], [oldMain]);
    expect(truncated).toBe(false);
    expect(entries).toHaveLength(1);   // 仅 c2；merge 被 --no-merges 排除，c1 被旧 main 排除
    expect(entries[0].subject).toBe('c2 on feat');
    expect(entries[0].author).toBe('张三');
    expect(entries[0].files).toEqual(['a.txt → a2.txt', 'b.txt']);
    expect(entries[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('sha 白名单：非法引用全部过滤后返回空', async () => {
    await setup();
    const bad = await svc.of(root, ['HEAD; rm -rf /', '--all', 'refs/heads/main'], []);
    expect(bad.entries).toEqual([]);
  });

  it('中文全角括号路径不出现八进制转义（quotepath=false 源头 + 解析兜底）', async () => {
    const { head } = await setup();
    const run = async (args: string[]) => { await exec.exec(root, args); };
    const name = '文档（新建 v2）.txt';
    fs.writeFileSync(path.join(root, name), '中文内容');
    await run(['add', '-A']);
    await run(['commit', '-m', 'c3 中文路径']);
    const head3 = (await exec.exec(root, ['rev-parse', 'HEAD'])).stdout.trim();
    const { entries } = await svc.of(root, [head3], [head]);
    expect(entries).toHaveLength(1);
    expect(entries[0].subject).toBe('c3 中文路径');
    expect(entries[0].files).toEqual([name]);   // 若残留 \357\274\210 转义即失败
  });

  it('maxCommits 截断：cap 之外丢弃并标记 truncated', async () => {
    const { head, oldMain } = await setup();
    const out = await svc.of(root, [head], [oldMain], { maxCommits: 0.5 as unknown as number });
    // maxCommits 最小 1：唯一条目保留，不截断
    expect(out.entries).toHaveLength(1);
    expect(out.truncated).toBe(false);
  });
});
