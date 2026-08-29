/**
 * 合并冲突链路冒烟（GITGRAPH_SMOKE=1 启用）：
 * 构造真实冲突仓库，验证 mergeKindOf / 冲突码保留 / contentAt stage 内容 /
 * 语义侧解决（--ours/--theirs + add）/ mergeActive 待完成态 / commit --no-edit / rebase --abort。
 * git 命令全部经 GitExecutor（spawn 参数数组，无 shell）。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { GitService } from '../../src/git/service';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('合并冲突冒烟', () => {
  let root: string;
  let exec: GitExecutor;
  let svc: GitService;

  async function setupConflict(): Promise<void> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-merge-'));
    exec = new GitExecutor('git');
    svc = new GitService(exec);
    process.env.GIT_AUTHOR_NAME = '张三';
    process.env.GIT_AUTHOR_EMAIL = 'z@x.y';
    process.env.GIT_COMMITTER_NAME = '张三';
    process.env.GIT_COMMITTER_EMAIL = 'z@x.y';
    const run = async (args: string[]) => { await exec.exec(root, args); };
    await run(['init', '-b', 'main']);
    fs.writeFileSync(path.join(root, 'app.ts'), 'line1\nline2\nline3\nline4\n');
    await run(['add', '-A']);
    await run(['commit', '-m', 'base']);
    await run(['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'app.ts'), 'line1\nline2-FEATURE\nline3\nline4\n');
    await run(['add', '-A']);
    await run(['commit', '-m', 'feature']);
    await run(['checkout', 'main']);
    fs.writeFileSync(path.join(root, 'app.ts'), 'line1\nline2-MAIN\nline3\nline4\n');
    await run(['add', '-A']);
    await run(['commit', '-m', 'main']);
    try { await run(['merge', '--no-edit', 'feature']); } catch { /* 冲突即预期 */ }
  }

  it('冲突检测 / stage 内容 / 二选一解决 / 待完成态 / 完成合并', async () => {
    await setupConflict();

    // 1) 冲突状态：UU 码保留 + mergeKind
    expect(svc.mergeKindOf(root)).toBe('merge');
    const wc = await svc.workingCopyOf(root);
    expect(wc.merging).toBe(true);
    expect(wc.mergeActive).toBe(true);
    expect(wc.conflicts).toHaveLength(1);
    expect(wc.conflicts[0].conflictCode).toBe('UU');
    expect(wc.conflicts[0].path).toBe('app.ts');

    // 2) 语义标签：MERGE_MSG 提取分支名 feature
    const labels = svc.mergeLabelsOf(root, 'merge');
    expect(labels.theirsRef).toBe('feature');
    expect(svc.mergeMsgOf(root)).toMatch(/feature/i);

    // 3) stage 内容：:2=我的（line2-MAIN）、:3=他人（line2-FEATURE）、:1=base（line2）
    const mine = await svc.contentAt(root, ':2', 'app.ts');
    const theirs = await svc.contentAt(root, ':3', 'app.ts');
    const base = await svc.contentAt(root, ':1', 'app.ts');
    expect(mine).toContain('line2-MAIN');
    expect(theirs).toContain('line2-FEATURE');
    expect(base).toContain('line2\n');

    // 4) 语义侧解决（panel.sideToOurs 的 merge 映射：mine → --ours）
    await exec.exec(root, ['checkout', '--ours', '--', 'app.ts']);
    await exec.exec(root, ['add', '--', 'app.ts']);
    const after = await svc.workingCopyOf(root);
    expect(after.conflicts).toHaveLength(0);
    expect(after.merging).toBe(false);
    expect(after.mergeActive).toBe(true);   // MERGE_HEAD 仍在 →「待完成合并」

    // 5) 完成合并（merge.finish 对应 commit --no-edit）
    await exec.exec(root, ['commit', '--no-edit']);
    expect(svc.mergeActiveOf(root)).toBe(false);
    const wcDone = await svc.workingCopyOf(root);
    expect(wcDone.merging).toBe(false);
    expect(wcDone.mergeActive).toBe(false);
  });

  it('rebase 语义反转 + rebase --abort 还原', async () => {
    await setupConflict();
    // 中止当前 merge → 改走 rebase 制造冲突（在 main 之上重放 feature 提交）
    await exec.exec(root, ['merge', '--abort']);
    expect(svc.mergeKindOf(root)).not.toBe('merge');

    // rebase（重放 feature 的提交，line2 冲突）
    try { await exec.exec(root, ['checkout', 'feature']); } catch { /* ignore */ }
    try { await exec.exec(root, ['rebase', 'main']); } catch { /* 冲突即预期 */ }
    expect(svc.mergeKindOf(root)).toBe('rebase');

    const wc = await svc.workingCopyOf(root);
    expect(wc.conflicts[0]?.conflictCode).toBe('UU');
    expect(wc.mergeKind).toBe('rebase');

    // rebase 语义反转：我的（正在重放）=:3，基底=:2
    const stage3 = await svc.contentAt(root, ':3', 'app.ts');
    const stage2 = await svc.contentAt(root, ':2', 'app.ts');
    expect(stage3).toContain('line2-FEATURE');   // 正在重放的 feature 改动
    expect(stage2).toContain('line2-MAIN');      // 基底（main）

    // mergeAbort 对应命令还原
    await exec.exec(root, ['rebase', '--abort']);
    const after = await svc.workingCopyOf(root);
    expect(after.merging).toBe(false);
    expect(after.mergeActive).toBe(false);
    const worktree = fs.readFileSync(path.join(root, 'app.ts'), 'utf8');
    expect(worktree).toContain('line2-FEATURE');   // 回到 feature 原状
  });
});
