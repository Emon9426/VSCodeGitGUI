/**
 * 文件历史页边界/性能/操作链集成测试（v0.14.1 完整测试轮；GITGRAPH_SMOKE=1 启用）。
 * 覆盖：长路径（core.longpaths）、中文全链路、特殊字符、二进制、空仓库、非法输入（反向）、
 * 移动/重命名/删除 op 后历史跟随（正向）、千文件/长历史/多次移动链性能、大 diff 超限。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { FilesService } from '../../src/git/files';
import { OpRunner } from '../../src/ops/runner';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

const GENV = {
  ...process.env,
  GIT_AUTHOR_NAME: '李四', GIT_AUTHOR_EMAIL: 'l@x.y',
  GIT_COMMITTER_NAME: '李四', GIT_COMMITTER_EMAIL: 'l@x.y',
};

function mkRepo(): { root: string; g: (...args: string[]) => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-edge-'));
  const g = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: root, env: GENV });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${String(r.stderr)}`);
  };
  g('init', '-b', 'main');
  g('config', 'core.longpaths', 'true');   // Windows 长路径前提（用户侧已启用场景）
  return { root, g };
}

describe.skipIf(!enabled)('文件页边界与性能', () => {
  // ---------- 反向：非法输入 ----------
  it('R-SEC 非法路径全部拒绝（注入面）', async () => {
    const { root } = mkRepo();
    const svc = new FilesService(new GitExecutor('git'));
    await expect(svc.fileLogOf(root, '../outside.txt')).rejects.toThrow();
    await expect(svc.fileLogOf(root, '--flag')).rejects.toThrow();
    await expect(svc.fileLogOf(root, ':(literal)x')).rejects.toThrow();
    await expect(svc.dirLogOf(root, '../../etc', true)).rejects.toThrow();
    await expect(svc.blobDiffOf(root, { sha: 'a'.repeat(40), path: 'ok.txt' }, { sha: 'nothex', path: 'ok.txt' })).rejects.toThrow();
    const ls = await svc.lsOf(root, '../outside');
    expect(ls.kind).toBe('none');
  });

  // ---------- 边界：空仓库 ----------
  it('R-EMPTY 空仓库：lsOf 根目录空 + kind=dir', async () => {
    const { root } = mkRepo();
    const svc = new FilesService(new GitExecutor('git'));
    const r = await svc.lsOf(root, '');
    expect(r.kind).toBe('dir');
    expect(r.items).toHaveLength(0);
  });

  // ---------- 边界：特殊字符路径 ----------
  it('E-CHAR 空格/全角括号/#/& 路径：浏览与历史', async () => {
    const { root, g } = mkRepo();
    const names = ['带 空格.txt', '全角（括号）.md', '井号#文件.txt', '和&与+.log'];
    for (const n of names) {
      fs.writeFileSync(path.join(root, n), `content of ${n}\n`);
    }
    g('add', '-A'); g('commit', '-m', '特殊字符文件');
    const svc = new FilesService(new GitExecutor('git'));
    const ls = await svc.lsOf(root, '');
    for (const n of names) {
      expect(ls.items.some(x => x.name === n)).toBe(true);
      const h = await svc.fileLogOf(root, n);
      expect(h.items).toHaveLength(1);
      expect(h.items[0].subject).toBe('特殊字符文件');
    }
  });

  // ---------- 用户核心场景 1：长路径 ----------
  it('P-LONG 长路径（>300 字符，core.longpaths）：浏览/历史/移动后跟随/两版比对', async () => {
    const { root, g } = mkRepo();
    // 12 级目录 × 26 字符 ≈ 340 字符前缀
    const seg = 'abcdefghijklmnopqrstuvwxyz'.slice(0, 24);
    let deep = '';
    for (let i = 0; i < 12; i++) deep += seg + String(i).padStart(2, '0') + path.sep;
    deep = deep.replace(/\\/g, '/');
    fs.mkdirSync(path.join(root, deep), { recursive: true });
    const file = deep + '长路径中文文档.md';
    fs.writeFileSync(path.join(root, file), 'v1\n');
    g('add', '-A'); g('commit', '-m', '长路径创建');
    expect(file.length).toBeGreaterThan(300);

    const svc = new FilesService(new GitExecutor('git'));
    // 浏览：最深目录能列出该文件
    const ls = await svc.lsOf(root, deep);
    expect(ls.items.some(x => x.name === '长路径中文文档.md')).toBe(true);
    // 重命名 → 移动到浅目录 → 历史跟随
    fs.mkdirSync(path.join(root, '归档'), { recursive: true });
    g('mv', file, '归档/文档.md');
    g('commit', '-m', '长路径归档');
    fs.appendFileSync(path.join(root, '归档', '文档.md'), 'v2 追加\n');
    g('add', '-A'); g('commit', '-m', '长路径归档后更新');
    const h = await svc.fileLogOf(root, '归档/文档.md');
    expect(h.items).toHaveLength(3);
    expect(h.items[2].eraPrefix).toBe(file);          // 移动前历史（当时长路径）
    expect(h.chain.segments).toHaveLength(2);
    // 纯移动两版（创建 v1 ↔ 移动后 v1，内容相同）→ empty；最早 ↔ 最新（内容有差异）→ diff
    const sameMove = await svc.blobDiffOf(root, { sha: h.items[2].sha, path: h.items[2].path }, { sha: h.items[1].sha, path: h.items[1].path });
    expect(sameMove.kind).toBe('empty');
    const p = await svc.blobDiffOf(root, { sha: h.items[2].sha, path: h.items[2].path }, { sha: h.items[0].sha, path: h.items[0].path });
    expect(p.kind).toBe('diff');
    // trackedOf
    expect(await svc.trackedOf(root, '归档/文档.md')).toBe(true);
  });

  // ---------- 用户核心场景 2：中文全链路 + 移动/重命名 op（正向） ----------
  it('P-CN 中文全链路：OpRunner 移动/重命名/删除 + 历史跟随 + 任意两版比对', async () => {
    const { root, g } = mkRepo();
    fs.mkdirSync(path.join(root, '项目甲'));
    fs.writeFileSync(path.join(root, '项目甲', '设计说明.md'), '第一稿\n');
    g('add', '-A'); g('commit', '-m', '创建设计说明');
    fs.writeFileSync(path.join(root, '项目甲', '设计说明.md'), '第一稿\n第二稿\n');
    g('add', '-A'); g('commit', '-m', '更新第二稿');

    const exec = new GitExecutor('git');
    const svc = new FilesService(exec);
    const runner = new OpRunner(exec);

    // 重命名 op（同目录 git mv）
    let out = await runner.run(root, { kind: 'renamePath', path: '项目甲/设计说明.md', name: '设计文档.md' }, 1, () => undefined, () => 'done');
    expect(out.ok).toBe(true);
    g('commit', '-m', '重命名');
    // 移动 op（目录级 git mv）
    fs.mkdirSync(path.join(root, '已完成'));
    out = await runner.run(root, { kind: 'moveFolder', srcs: ['项目甲'], dst: '已完成' }, 2, () => undefined, () => 'done');
    expect(out.ok).toBe(true);
    g('commit', '-m', '归档移动');
    fs.writeFileSync(path.join(root, '已完成', '项目甲', '设计文档.md'), '第一稿\n第二稿\n终稿\n');
    g('add', '-A'); g('commit', '-m', '终稿更新');

    // 历史跟随：重命名+移动前的提交全部可见
    const h = await svc.fileLogOf(root, '已完成/项目甲/设计文档.md');
    expect(h.items).toHaveLength(5);
    expect(h.items[4].subject).toBe('创建设计说明');
    expect(h.items[4].eraPrefix).toBe('项目甲/设计说明.md');
    const miles = h.items.filter(i => i.milestone);
    expect(miles).toHaveLength(2);
    expect(h.chain.segments.map(s => s.prefix)).toEqual(['已完成/项目甲/设计文档.md', '项目甲/设计文档.md', '项目甲/设计说明.md']);

    // 任意两版比对：最早（旧名）↔ 最新
    const oldest = h.items[4], latest = h.items[0];
    const p = await svc.blobDiffOf(root, { sha: oldest.sha, path: oldest.path }, { sha: latest.sha, path: latest.path });
    expect(p.kind).toBe('diff');
    if (p.kind === 'diff') {
      const text = p.diff.hunks.flatMap(x => x.lines).map(l => l.text).join('\n');
      expect(text).toContain('终稿');
    }
    // 目录级历史（链反查）
    const dl = await svc.dirLogOf(root, '已完成/项目甲', true);
    expect(dl.chain.segments.map(s => s.prefix)).toEqual(['已完成/项目甲', '项目甲']);
    expect(dl.items.some(i => i.milestone)).toBe(true);
    // 删除 op（git rm）
    out = await runner.run(root, { kind: 'deletePaths', paths: ['已完成/项目甲/设计文档.md'] }, 3, () => undefined, () => 'done');
    expect(out.ok).toBe(true);
    expect(await svc.trackedOf(root, '已完成/项目甲/设计文档.md')).toBe(false);
    // 删除后（提交前）历史仍可查（index 删除不影响 HEAD 历史）
    const h2 = await svc.fileLogOf(root, '已完成/项目甲/设计文档.md');
    expect(h2.items).toHaveLength(5);
  });

  // ---------- 反向：OpRunner 非法操作 ----------
  it('R-OP 非法 op：目标父目录不存在时失败且不影响原文件', async () => {
    const { root, g } = mkRepo();
    fs.writeFileSync(path.join(root, 'a.txt'), 'x');
    g('add', '-A'); g('commit', '-m', 'init');
    const runner = new OpRunner(new GitExecutor('git'));
    // git mv src dst：dst 为已存在目录时移入；父目录不存在时失败（不会静默改名——dst 是路径而非裸名）
    fs.mkdirSync(path.join(root, '目标目录'));
    const out = await runner.run(root, { kind: 'moveFolder', srcs: ['a.txt'], dst: '不存在的父目录/子目录' }, 9, () => undefined, () => 'done');
    expect(out.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);   // 原文件未受影响
    // 重命名为已存在名 → 失败
    fs.writeFileSync(path.join(root, 'b.txt'), 'y');
    const out2 = await runner.run(root, { kind: 'renamePath', path: 'a.txt', name: 'b.txt' }, 10, () => undefined, () => 'done');
    expect(out2.ok).toBe(false);
    expect(fs.existsSync(path.join(root, 'a.txt'))).toBe(true);
  });

  // ---------- 边界：二进制 ----------
  it('E-BIN 二进制文件：历史正常 + 比对返回 binary', async () => {
    const { root, g } = mkRepo();
    // 含 NUL 字节才会被 git 判定为二进制（无 NUL 的短字节串会被当文本 diff）
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    fs.writeFileSync(path.join(root, '图片.png'), png);
    g('add', '-A'); g('commit', '-m', 'add png');
    fs.writeFileSync(path.join(root, '图片.png'), Buffer.from([...png, 9, 10, 11]));
    g('add', '-A'); g('commit', '-m', 'update png');
    const svc = new FilesService(new GitExecutor('git'));
    const h = await svc.fileLogOf(root, '图片.png');
    expect(h.items).toHaveLength(2);
    const p = await svc.blobDiffOf(root, { sha: h.items[1].sha, path: '图片.png' }, { sha: h.items[0].sha, path: '图片.png' });
    expect(p.kind).toBe('binary');
  });

  // ---------- 性能 ----------
  it('PERF 千文件目录浏览', async () => {
    const { root, g } = mkRepo();
    fs.mkdirSync(path.join(root, '大目录'), { recursive: true });
    for (let i = 0; i < 1000; i++) {
      fs.writeFileSync(path.join(root, '大目录', `文件${String(i).padStart(4, '0')}.txt`), `x${i}`);
    }
    g('add', '-A'); g('commit', '-m', 'bulk');
    const svc = new FilesService(new GitExecutor('git'));
    const t0 = Date.now();
    const ls = await svc.lsOf(root, '大目录');
    const ms = Date.now() - t0;
    expect(ls.items).toHaveLength(1000);
    expect(ms).toBeLessThan(5000);   // 首次含 ls-tree + 千次 stat
    // 二次（缓存命中）应显著更快
    const t1 = Date.now();
    await svc.lsOf(root, '');
    expect(Date.now() - t1).toBeLessThan(ms + 100);
  });

  it('PERF 长历史文件查询（300 提交）', async () => {
    const { root, g } = mkRepo();
    fs.writeFileSync(path.join(root, '演化.md'), 'v0\n');
    g('add', '-A'); g('commit', '-m', 'c0');
    for (let i = 1; i < 300; i++) {
      fs.appendFileSync(path.join(root, '演化.md'), `line${i}\n`);
      g('add', '演化.md');
      g('commit', '-m', `c${i}`);
    }
    const svc = new FilesService(new GitExecutor('git'));
    const t0 = Date.now();
    const h = await svc.fileLogOf(root, '演化.md');
    const ms = Date.now() - t0;
    expect(h.items).toHaveLength(300);
    expect(ms).toBeLessThan(5000);
  });

  it('PERF 多次移动链（5 次）目录历史反查', async () => {
    const { root, g } = mkRepo();
    let dir = '第0阶段';
    fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, dir, '工作.md'), 'start\n');
    g('add', '-A'); g('commit', '-m', '创建');
    for (let i = 1; i <= 5; i++) {
      const next = `第${i}阶段`;
      const target = `${next}/${dir}`;
      fs.mkdirSync(path.join(root, target), { recursive: true });   // git mv 不创建中间目录，先建目标
      fs.rmdirSync(path.join(root, target));                         // 建父目录后再移除叶子（mv 目标名与源同名）
      g('mv', dir, target);
      g('commit', '-m', `移入${next}`);
      fs.appendFileSync(path.join(root, next, dir, '工作.md'), `r${i}\n`);
      g('add', '-A'); g('commit', '-m', `修改${i}`);
      dir = `${next}/${dir}`;
    }
    const svc = new FilesService(new GitExecutor('git'));
    const t0 = Date.now();
    const dl = await svc.dirLogOf(root, dir, true);
    const ms = Date.now() - t0;
    expect(dl.chain.segments).toHaveLength(6);      // 6 段（5 次移动）
    expect(dl.items.filter(i => i.milestone)).toHaveLength(5);
    expect(dl.items).toHaveLength(11);              // 创建 + 5×(移动+修改)
    expect(ms).toBeLessThan(8000);
    // 文件级同样 6 段
    const h = await svc.fileLogOf(root, dir + '/工作.md');
    expect(h.chain.segments).toHaveLength(6);
  });

  it('PERF 大 diff 超限 → tooLarge', async () => {
    const { root, g } = mkRepo();
    const lines0 = Array.from({ length: 6000 }, (_, i) => `line ${i}`);
    fs.writeFileSync(path.join(root, '大文件.txt'), lines0.join('\n') + '\n');
    g('add', '-A'); g('commit', '-m', 'big v1');
    fs.writeFileSync(path.join(root, '大文件.txt'), lines0.map(l => l + ' changed').join('\n') + '\n');
    g('add', '-A'); g('commit', '-m', 'big v2');
    const svc = new FilesService(new GitExecutor('git'));
    const h = await svc.fileLogOf(root, '大文件.txt');
    const p = await svc.blobDiffOf(root, { sha: h.items[1].sha, path: '大文件.txt' }, { sha: h.items[0].sha, path: '大文件.txt' });
    expect(p.kind).toBe('tooLarge');
  });
});
