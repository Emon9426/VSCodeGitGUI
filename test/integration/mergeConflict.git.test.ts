/**
 * Issue #7 冲突解决全链路冒烟（GITGRAPH_SMOKE=1 启用）：
 * 三类文件（纯文本 / 二进制图片 / 万行代码）真实冲突仓库——
 * 冲突码检测 → stage 内容 → classifyMergeSession 分类 → OpRunner.resolveConflict
 * （走双队列执行器）语义侧解决 → 工作副本状态流转 → 完成合并。
 * 二进制字节以 cat-file 直读比对（不经 utf8 字符串，防有损）。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { GitService } from '../../src/git/service';
import { classifyMergeSession } from '../../src/git/parse';
import { OpRunner } from '../../src/ops/runner';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

/** 真实 PNG 头（含 IHDR NUL 字段）——git 视角的二进制 */
function png(payload: string): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 'I', 'H', 'D', 'R']);
  return Buffer.concat([header, Buffer.from(payload, 'latin1'), Buffer.from([0x00, 0x00, 0x00, 0x00])]);
}

/** xlsx/ZIP 容器头（PK\x03\x04 + NUL 版本字段） */
function zip(payload: string): Buffer {
  const header = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
  return Buffer.concat([header, Buffer.from(payload, 'latin1')]);
}

function bigSource(n: number, marker: string): string {
  const parts: string[] = ['// 万行级源文件（冲突测试）'];
  for (let i = 2; i <= n; i++) parts.push(i === Math.floor(n / 2) ? `export const KEY = '${marker}'; // 第 ${i} 行` : `export const v${i} = ${i};`);
  return parts.join('\n') + '\n';
}

describe.skipIf(!enabled)('冲突解决全链路（文本/二进制/万行，Issue #7）', () => {
  let root: string;
  let exec: GitExecutor;
  let svc: GitService;
  let runner: OpRunner;
  let opSeq = 0;

  /** cat-file 二进制安全读取（buffer 直出，不经 utf8） */
  const blob = (spec: string): Buffer =>
    spawnSync('git', ['-C', root, 'cat-file', 'blob', spec], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 }).stdout;

  async function setup(): Promise<void> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-conflict-'));
    exec = new GitExecutor('git');
    svc = new GitService(exec);
    runner = new OpRunner(exec);
    process.env.GIT_AUTHOR_NAME = '张三';
    process.env.GIT_AUTHOR_EMAIL = 'z@x.y';
    process.env.GIT_COMMITTER_NAME = '张三';
    process.env.GIT_COMMITTER_EMAIL = 'z@x.y';
    const run = async (args: string[]) => { await exec.exec(root, args); };

    await run(['init', '-b', 'main']);
    await run(['config', 'core.autocrlf', 'false']);   // 字节级断言：关掉本机全局 CRLF 转换
    // 三类基线文件：纯文本 / 图片二进制 / Excel 二进制 / 万行代码
    fs.writeFileSync(path.join(root, 'text.md'), '# doc\nhello base\n');
    fs.writeFileSync(path.join(root, 'logo.png'), png('base-image'));
    fs.writeFileSync(path.join(root, 'data.xlsx'), zip('base-sheet'));
    fs.writeFileSync(path.join(root, 'big.js'), bigSource(10000, 'base'));
    await run(['add', '-A']);
    await run(['commit', '-m', 'base']);

    await run(['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(root, 'text.md'), '# doc\nhello FEATURE\n');
    fs.writeFileSync(path.join(root, 'logo.png'), png('feature-image'));
    fs.writeFileSync(path.join(root, 'data.xlsx'), zip('feature-sheet'));
    fs.writeFileSync(path.join(root, 'big.js'), bigSource(10000, 'FEATURE'));
    await run(['add', '-A']);
    await run(['commit', '-m', 'feature']);

    await run(['checkout', 'main']);
    fs.writeFileSync(path.join(root, 'text.md'), '# doc\nhello MAIN\n');
    fs.writeFileSync(path.join(root, 'logo.png'), png('main-image'));
    fs.writeFileSync(path.join(root, 'data.xlsx'), zip('main-sheet'));
    fs.writeFileSync(path.join(root, 'big.js'), bigSource(10000, 'MAIN'));
    await run(['add', '-A']);
    await run(['commit', '-m', 'main']);
    try { await run(['merge', '--no-edit', 'feature']); } catch { /* 冲突即预期 */ }
  }

  it('三类文件均入冲突组（UU），分类正确（文本/万行=文本会话，图片/Excel=二进制会话）', async () => {
    await setup();
    const wc = await svc.workingCopyOf(root);
    expect(wc.merging).toBe(true);
    const byPath = new Map(wc.conflicts.map(c => [c.path, c]));
    expect([...byPath.keys()].sort()).toEqual(['big.js', 'data.xlsx', 'logo.png', 'text.md']);
    for (const p of byPath.keys()) expect(byPath.get(p)!.conflictCode).toBe('UU');

    // 分类：mine=:2（MAIN 侧） / theirs=:3（FEATURE 侧）
    for (const p of ['text.md', 'big.js', 'logo.png', 'data.xlsx']) {
      const mine = await svc.contentAt(root, ':2', p);
      const theirs = await svc.contentAt(root, ':3', p);
      const cls = classifyMergeSession('merge', byPath.get(p)!.conflictCode ?? 'UU', mine, theirs);
      if (p === 'logo.png' || p === 'data.xlsx') expect(cls.binary, p).toBe(true);
      else expect(cls.binary, p).toBe(false);
      expect(cls.tooLarge, p).toBe(false);   // 万行（10000）< 16000 上限
      if (p === 'big.js') expect(cls.lines).toBe(10001);   // 万行 + 行尾换行的空尾段
    }

    // stage 内容语义正确
    expect(await svc.contentAt(root, ':2', 'text.md')).toContain('hello MAIN');
    expect(await svc.contentAt(root, ':3', 'text.md')).toContain('hello FEATURE');
    expect(await svc.contentAt(root, ':2', 'big.js')).toContain("'MAIN'");
    expect(await svc.contentAt(root, ':3', 'big.js')).toContain("'FEATURE'");
  });

  it('runner.resolveConflict 语义侧解决三类文件：文本/万行内容精确、二进制字节级一致', async () => {
    await setup();
    // 期望侧字节先取（解决后 stage 3 仍可读，但取期望值放前面更稳）
    const wantOurs = {
      'text.md': Buffer.from('# doc\nhello MAIN\n'),
      'big.js': null as Buffer | null,
      'logo.png': blob(':2:logo.png'),
      'data.xlsx': blob(':2:data.xlsx'),
    };
    wantOurs['big.js'] = blob(':2:big.js');

    // 逐文件走 OpRunner（本地道）：mine → semanticToOurs('merge', false)=true → --ours
    for (const p of ['text.md', 'logo.png', 'data.xlsx', 'big.js']) {
      const out = await runner.run(root, { kind: 'resolveConflict', paths: [p], ours: true }, ++opSeq, () => undefined, () => 'R');
      expect(out.ok, p).toBe(true);
    }

    const wc = await svc.workingCopyOf(root);
    expect(wc.conflicts).toHaveLength(0);
    expect(wc.merging).toBe(false);
    expect(wc.mergeActive).toBe(true);   // 待完成合并

    // 文本/万行：内容精确等于 :2
    expect(fs.readFileSync(path.join(root, 'text.md'), 'utf8')).toBe(wantOurs['text.md'].toString('utf8'));
    expect(fs.readFileSync(path.join(root, 'big.js'), 'utf8')).toBe(wantOurs['big.js']!.toString('utf8'));
    // 二进制：字节级一致（checkout --ours 写入的就是 :2 blob）
    expect(fs.readFileSync(path.join(root, 'logo.png')).equals(wantOurs['logo.png']!)).toBe(true);
    expect(fs.readFileSync(path.join(root, 'data.xlsx')).equals(wantOurs['data.xlsx']!)).toBe(true);
    // 万行文件尺寸合理（未被截断/篡改）
    expect(fs.statSync(path.join(root, 'big.js')).size).toBeGreaterThan(150_000);
  });

  it('对方侧（--theirs）解决 + 完成合并（commit --no-edit）', async () => {
    await setup();
    for (const p of ['text.md', 'logo.png', 'data.xlsx', 'big.js']) {
      const out = await runner.run(root, { kind: 'resolveConflict', paths: [p], ours: false }, ++opSeq, () => undefined, () => 'R');
      expect(out.ok, p).toBe(true);
    }
    expect((await svc.workingCopyOf(root)).conflicts).toHaveLength(0);
    expect(fs.readFileSync(path.join(root, 'text.md'), 'utf8')).toContain('hello FEATURE');

    await exec.exec(root, ['commit', '--no-edit']);
    const wc = await svc.workingCopyOf(root);
    expect(wc.mergeActive).toBe(false);
    expect(wc.dirtyCount).toBe(0);
  });

  it('万行冲突标记解析（前端 merge/parse）：10000 行会话可解析出冲突块', async () => {
    await setup();
    const { parseMergeResult } = await import('../../src/ui/merge/parse');
    const raw = fs.readFileSync(path.join(root, 'big.js'), 'utf8');
    expect(raw).toContain('<<<<<<<');
    const parsed = parseMergeResult(raw);
    expect(parsed.hasMarkers).toBe(true);
    expect(parsed.chunks.length).toBeGreaterThanOrEqual(1);
    expect(parsed.chunks[0].mineLines.some(l => l.includes("'MAIN'"))).toBe(true);
    expect(parsed.chunks[0].theirsLines.some(l => l.includes("'FEATURE'"))).toBe(true);
    const total = parsed.segs.reduce((n, s) => n + (s.type === 'common' ? s.lines.length : 0), 0);
    expect(total).toBeGreaterThan(9000);   // 万行主体都在公共段
  });
});
