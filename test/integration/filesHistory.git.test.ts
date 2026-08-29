/**
 * 文件历史页真实 git 集成测试（v0.14；GITGRAPH_SMOKE=1 启用）：
 * 临时仓库构造"创建 → 重命名 → 目录移动 → 继续修改"链，验证
 * fileLogOf（--follow 全历史）/ dirLogOf（链反查）/ blobDiffOf（跨移动比对）/ lsOf（快照+kind）。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { FilesService } from '../../src/git/files';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

const GENV = {
  ...process.env,
  GIT_AUTHOR_NAME: '张三', GIT_AUTHOR_EMAIL: 'z@x.y',
  GIT_COMMITTER_NAME: '张三', GIT_COMMITTER_EMAIL: 'z@x.y',
};

describe.skipIf(!enabled)('文件历史页 git 集成', () => {
  let root: string;
  let svc: FilesService;

  it('fileLogOf：重命名+移动后完整历史与链', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-files-'));
    svc = new FilesService(new GitExecutor('git'));
    const g = (...args: string[]) => {
      const r = spawnSync('git', args, { cwd: root, env: GENV });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${String(r.stderr)}`);
    };
    g('init', '-b', 'main');
    // 创建 → 修改 → 重命名 → 目录移动 → 继续修改（v1.4 §4.4 的实测链）
    fs.mkdirSync(path.join(root, 'A'));
    fs.writeFileSync(path.join(root, 'A', '需求草稿.md'), 'v1\n');
    g('add', '-A'); g('commit', '-m', '创建需求草稿');
    fs.writeFileSync(path.join(root, 'A', '需求草稿.md'), 'v1\nv2\n');
    g('add', '-A'); g('commit', '-m', '修改草稿');
    g('mv', 'A/需求草稿.md', 'A/需求说明.md');
    g('commit', '-m', '重命名定稿');
    fs.writeFileSync(path.join(root, 'A', '需求说明.md'), 'v1\nv2\nv3\n');
    g('add', '-A'); g('commit', '-m', '更新说明');
    fs.mkdirSync(path.join(root, 'B'));
    g('mv', 'A', 'B/A');
    g('commit', '-m', '归档移动');
    fs.writeFileSync(path.join(root, 'B', 'A', '需求说明.md'), 'v1\nv2\nv3\nv4\n');
    g('add', '-A'); g('commit', '-m', '移动后修改');

    const { items, chain } = await svc.fileLogOf(root, 'B/A/需求说明.md');
    expect(items).toHaveLength(6);
    expect(items[0].subject).toBe('移动后修改');
    expect(items[5].subject).toBe('创建需求草稿');
    // 重命名前的历史带当时路径徽标
    expect(items[5].eraPrefix).toBe('A/需求草稿.md');
    expect(items[4].eraPrefix).toBe('A/需求草稿.md');
    expect(items[0].eraPrefix).toBeUndefined();
    // 里程碑：重命名 + 移动
    const miles = items.filter(i => i.milestone);
    expect(miles).toHaveLength(2);
    expect(miles[1].oldPath).toBe('A/需求草稿.md');
    expect(miles[0].oldPath).toBe('A/需求说明.md');
    // 链：segments 新→旧共 3 段
    expect(chain.segments).toHaveLength(3);
    expect(chain.segments[0].prefix).toBe('B/A/需求说明.md');
    expect(chain.segments[2].prefix).toBe('A/需求草稿.md');
  });

  it('dirLogOf：目录链反查（A → B/A）与里程碑切分', async () => {
    const { items, chain } = await svc.dirLogOf(root, 'B/A', true);
    expect(chain.segments).toHaveLength(2);
    expect(chain.segments[0].prefix).toBe('B/A');
    expect(chain.segments[1].prefix).toBe('A');
    expect(items.length).toBeGreaterThanOrEqual(6);
    // 时期：A 时期条目带 eraPrefix=A；移动提交为里程碑
    const aEra = items.filter(i => i.eraPrefix === 'A');
    expect(aEra.length).toBeGreaterThanOrEqual(3);   // 创建/修改/重命名/更新（无 follow 前的 A 时期）
    expect(items.some(i => i.milestone)).toBe(true);
    // follow=false：仅当前路径时期
    const noFollow = await svc.dirLogOf(root, 'B/A', false);
    expect(noFollow.chain.segments).toHaveLength(1);
    expect(noFollow.items.every(i => !i.eraPrefix)).toBe(true);
  });

  it('blobDiffOf：跨重命名+移动的两版比对', async () => {
    const { items } = await svc.fileLogOf(root, 'B/A/需求说明.md');
    const oldest = items[items.length - 1];   // 创建（当时 A/需求草稿.md）
    const latest = items[0];
    expect(oldest.path).toBe('A/需求草稿.md');
    expect(latest.path).toBe('B/A/需求说明.md');
    const p = await svc.blobDiffOf(root, { sha: oldest.sha, path: oldest.path }, { sha: latest.sha, path: latest.path });
    expect(p.kind).toBe('diff');
    if (p.kind === 'diff') {
      const text = p.diff.hunks.flatMap(h => h.lines).map(l => l.text).join('\n');
      expect(text).toContain('v4');
    }
    // 相同两版 → empty
    const same = await svc.blobDiffOf(root, { sha: oldest.sha, path: oldest.path }, { sha: oldest.sha, path: oldest.path });
    expect(same.kind).toBe('empty');
  });

  it('lsOf：目录子项 + kind 判定 + 中文路径 stat', async () => {
    const rootLs = await svc.lsOf(root, '');
    expect(rootLs.kind).toBe('dir');
    const names = rootLs.items.map(x => x.name);
    expect(names).toContain('B');
    const bDir = rootLs.items.find(x => x.name === 'B')!;
    expect(bDir.isDir).toBe(true);
    expect(bDir.count).toBeGreaterThanOrEqual(1);

    const baLs = await svc.lsOf(root, 'B/A');
    expect(baLs.kind).toBe('dir');
    const f = baLs.items.find(x => x.name === '需求说明.md')!;
    expect(f.isDir).toBe(false);
    expect(f.size).toBeGreaterThan(0);          // 工作区 stat
    expect(f.mtime).toBeDefined();

    const file = await svc.lsOf(root, 'B/A/需求说明.md');
    expect(file.kind).toBe('file');
    const none = await svc.lsOf(root, '不存在的路径');
    expect(none.kind).toBe('none');
  });

  it('trackedOf：已跟踪/未跟踪判定', async () => {
    expect(await svc.trackedOf(root, 'B/A/需求说明.md')).toBe(true);
    expect(await svc.trackedOf(root, 'no-such-file.txt')).toBe(false);
    fs.writeFileSync(path.join(root, '新文件.txt'), 'x');
    expect(await svc.trackedOf(root, '新文件.txt')).toBe(false);
  });

  it('fileLogOf 拒绝白名单外路径', async () => {
    await expect(svc.fileLogOf(root, '--inject')).rejects.toThrow();
  });
});
