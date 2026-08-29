/**
 * revealableAncestor：Windows explorer 长路径降级（>259 上溯最深可用祖先）。
 */
import { describe, expect, it } from 'vitest';
import { EXPLORER_MAX_PATH, revealableAncestor } from '../../src/webview/revealPath';

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
