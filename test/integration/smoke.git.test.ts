/**
 * 真实 git 冒烟测试（需要系统 git；设置 GITGRAPH_SMOKE=1 启用）。
 * 在临时目录构造小型仓库，验证 LOG_FORMAT / EACH_REF_FORMAT 在真实输出的解析。
 */
import { execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { GitService } from '../../src/git/service';
import { discoverRepos } from '../../src/git/discovery';
import { LOG_FORMAT, EACH_REF_FORMAT, parseLog, parseForEachRef, parseStatus } from '../../src/git/parse';
import { computeLanes } from '../../src/graph/lanes';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

describe.skipIf(!enabled)('git 冒烟', () => {
  let root: string;
  let exec: GitExecutor;

  it('构造仓库并验证全链路解析', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-smoke-'));
    exec = new GitExecutor('git');
    const g = (cmd: string) => execSync(cmd, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: '张三', GIT_AUTHOR_EMAIL: 'z@x.y', GIT_COMMITTER_NAME: '张三', GIT_COMMITTER_EMAIL: 'z@x.y', GIT_AUTHOR_DATE: '2026-08-19T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-08-19T10:00:00+08:00' } });

    g('git init -b main');
    fs.writeFileSync(path.join(root, '中文 文件.txt'), 'a\nb\nc\n');
    g('git add -A');
    g('git commit -m "首个提交: 初始化"');
    execSync('git checkout -b feature', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, '中文 文件.txt'), 'a\nB\nc\nd\n');
    g('git add -A');
    g('git commit -m "feature 变更"');
    execSync('git checkout main', { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'readme.md'), '# hi\n');
    g('git add -A');
    g('git commit -m "main 变更"');
    g('git merge --no-ff --no-edit feature');
    g('git tag -a v1.0 -m "release"');
    g('git tag light-weight');

    // refs
    const refOut = (await exec.exec(root, ['for-each-ref', `--format=${EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'])).stdout;
    const refs = parseForEachRef(refOut);
    expect(refs.some(r => r.short === 'main')).toBe(true);
    expect(refs.some(r => r.short === 'feature')).toBe(true);
    const annotated = refs.find(r => r.short === 'v1.0')!;
    expect(annotated.sha).toMatch(/^[0-9a-f]{40}$/);

    // log
    const logOut = (await exec.exec(root, ['log', '--topo-order', '--date=iso-strict', `--pretty=format:${LOG_FORMAT}`, '-n', '10', '--all'])).stdout;
    const commits = parseLog(logOut, {
      localBranches: new Set(['main', 'feature']),
      remoteBranches: new Set(),
    });
    expect(commits.length).toBe(4);   // 初始 + feature 变更 + main 变更 + merge
    const merge = commits.find(c => c.parents.length === 2)!;
    expect(merge).toBeTruthy();
    const head = commits[0];
    expect(head.refs.some(r => r.isHead && r.name === 'main')).toBe(true);
    const tagged = commits.find(c => c.refs.some(r => r.kind === 'tag' && r.name === 'v1.0'))!;
    expect(tagged.sha).toBe(merge.sha);

    // lanes
    const graph = computeLanes(commits);
    expect(graph.laneCount).toBe(2);
    expect(graph.curves.some(c => c.kind === 'fork')).toBe(true);
    expect(graph.curves.some(c => c.kind === 'mergeIn')).toBe(true);

    // 提交详情（含中文与空格文件名）—— 直接走 GitService.detailOf 真实路径
    const svc = new GitService(exec);
    const detail = await svc.detailOf(root, merge);
    const files = detail.files;
    expect(files.some(f => f.path === '中文 文件.txt')).toBe(true);

    // 内联 diff：commit 模式必须以第一父为基线（回归：曾误用空树导致整文件显示为新增）
    const featureCommit = commits.find(c => c.subject.startsWith('feature'))!;
    const dp = await svc.diffOf(root, 'commit', featureCommit.sha, '中文 文件.txt');
    expect(dp.kind).toBe('diff');
    if (dp.kind === 'diff') {
      const lines = dp.diff.hunks.flatMap(h => h.lines);
      expect(lines.filter(l => l.kind === 'add').length).toBe(2);   // +B +d
      expect(lines.filter(l => l.kind === 'del').length).toBe(1);   // -b
    }

    // Windows 回归：git 返回正斜杠根路径必须被规范化（曾致 safeJoin 全部误判越界）
    const metas = await discoverRepos(exec, [{ uri: { fsPath: root } }]);
    expect(metas).toHaveLength(1);
    expect(metas[0].root.includes('/')).toBe(false);

    // 状态
    const st = parseStatus((await exec.exec(root, ['status', '--porcelain=v1', '-b'])).stdout);
    expect(st.branch).toBe('main');
    expect(st.dirtyCount).toBe(0);
  });
});
