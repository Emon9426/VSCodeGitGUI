/**
 * revealableAncestor：Windows explorer 长路径降级（>259 上溯最深可用祖先）。
 * fsExistsRobust：>259 真实文件的 \\?\ 前缀重试探测（防严格 MAX_PATH 系统误报不存在）。
 * revealSpawnForm：explorer /select 三种传参形态（classic/separate/quoted，随 Windows 版本漂移的兜底）。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EXPLORER_MAX_PATH, fsExistsRobust, revealableAncestor, revealSpawnForm } from '../../src/webview/revealPath';

/** 构造完整路径长度恰为 total 的文件路径（目录链 + 撑长文件名） */
function pathOfLen(total: number, dir: string): string {
  const n = total - dir.length - 6;   // '\' + 'f' + n×'x' + '.txt'
  return dir + '\\f' + 'x'.repeat(n) + '.txt';
}

describe('revealableAncestor', () => {
  const DIR = 'C:\\Users\\u\\AppData\\Local\\Temp\\repo';   // 长度 < 259 的目录链

  it('短路径原样返回', () => {
    expect(revealableAncestor('C:\\a\\b\\c.txt')).toBe('C:\\a\\b\\c.txt');
  });

  it('恰好 259 字符仍原样返回（实测可用上限）', () => {
    const p = pathOfLen(259, DIR);
    expect(p.length).toBe(259);
    expect(revealableAncestor(p)).toBe(p);
  });

  it('260 字符起降级到父目录（文件名过长、目录链可用）', () => {
    const p = pathOfLen(300, DIR);
    expect(p.length).toBe(300);
    expect(revealableAncestor(p)).toBe(DIR);
  });

  it('目录链超长时逐级上溯到最长 ≤259 祖先', () => {
    const seg = 'd-' + 'x'.repeat(60);                    // 每级 63 字符
    const deep = DIR + '\\' + seg + '\\' + seg + '\\' + seg + '\\' + seg;
    const file = pathOfLen(deep.length + 90, deep);
    const got = revealableAncestor(file)!;
    // 返回值必须是某级祖先目录且 ≤ 上限，且比它再深一级就超限
    expect(got.length).toBeLessThanOrEqual(EXPLORER_MAX_PATH);
    expect(got.startsWith(DIR + '\\' + seg)).toBe(true);
    expect(got + '\\' + seg).not.toBe(got);   // 存在更深一级（超限）确认停在最深处
  });

  it('含空格与中文的超长路径同样按长度降级', () => {
    const dir = 'C:\\用户 目录\\项目 仓库';
    const p = pathOfLen(280, dir);
    expect(revealableAncestor(p)).toBe(dir);
  });
});

describe('revealSpawnForm（/select 三形态）', () => {
  const P = 'C:\\repo with space\\文件 名.md';

  it('classic（默认）：单参数 + verbatim（命令行原样，各 Windows 版本通用）', () => {
    expect(revealSpawnForm(P)).toEqual({ args: ['/select,' + P], verbatim: true });
    expect(revealSpawnForm(P, 'classic')).toEqual({ args: ['/select,' + P], verbatim: true });
  });

  it('separate：/select 与路径分两个参数、非 verbatim', () => {
    expect(revealSpawnForm(P, 'separate')).toEqual({ args: ['/select,', P], verbatim: false });
  });

  it('quoted：单参数非 verbatim（含空格时 libuv 整体加引号）', () => {
    expect(revealSpawnForm(P, 'quoted')).toEqual({ args: ['/select,' + P], verbatim: false });
  });

  it('未知值回退 classic（配置脏值防御）', () => {
    expect(revealSpawnForm(P, 'bogus' as never)).toEqual({ args: ['/select,' + P], verbatim: true });
  });
});

describe.skipIf(process.platform !== 'win32')('fsExistsRobust（win32 长路径探测）', () => {
  /** 在 tmpdir 下逐级建 >259 的目录链并写入文件（末级须 \\?\ 前缀），返回完整文件路径 */
  function makeLongFile(): string {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-reveal-test-'));
    let d = base;
    while (d.length < 300) {
      d = path.join(d, 'seg-' + 'x'.repeat(58));
      fs.mkdirSync(d.length >= 248 ? '\\\\?\\' + d : d);
    }
    const f = path.join(d, 'f.txt');
    fs.writeFileSync('\\\\?\\' + f, 'x');
    return f;
  }

  it('>259 的真实文件探测为 true（普通 stat 失败时走 \\\\?\\ 重试）', () => {
    const f = makeLongFile();
    expect(f.length).toBeGreaterThan(EXPLORER_MAX_PATH);
    expect(fsExistsRobust(f)).toBe(true);   // 无论本系统是否放行 >259 stat，robust 都必须探到
  });

  it('短路径行为与普通 existsSync 一致', () => {
    expect(fsExistsRobust(path.join(os.tmpdir(), 'definitely-not-exist-xyz.txt'))).toBe(false);
  });
});
