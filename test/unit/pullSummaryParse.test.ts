import { describe, expect, it } from 'vitest';
import { parseSummaryLog, unescapeGitPath, SUMMARY_FORMAT } from '../../src/git/parse';

/** 模拟 `git log --pretty=format:SUMMARY_FORMAT --name-status -M` 的真实输出：pretty 行以 \x1e 结束，文件行随后，条目间空行 */
function log(entries: { sha: string; short: string; author: string; date: string; subject: string; files: string[] }[]): string {
  return entries
    .map(e => [[e.sha, e.short, e.author, e.date, e.subject].join('\x1f') + '\x1e', ...e.files].join('\n'))
    .join('\n\n') + '\n';
}

describe('parseSummaryLog（Pull/Fetch 纯净提交摘要）', () => {
  const mk = (over: Partial<Parameters<typeof log>[0][number]> = {}) => ({
    sha: 'a'.repeat(40), short: 'aaaaaaa', author: '张三', date: '2026-08-26T10:00:00+08:00',
    subject: '修复登录', files: ['M\tsrc/a.ts', 'A\tdocs/b.md'], ...over,
  });

  it('常规字段与文件行解析（M/A 状态）', () => {
    const out = parseSummaryLog(log([mk()]), 50);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sha: 'a'.repeat(40), shortSha: 'aaaaaaa', author: '张三', subject: '修复登录' });
    expect(out[0].files).toEqual(['src/a.ts', 'docs/b.md']);
    expect(out[0].filesTruncated).toBe(false);
  });

  it('重命名 R100 输出为 "旧路径 → 新路径"', () => {
    const out = parseSummaryLog(log([mk({ files: ['R100\told/name.ts\tnew/name.ts'] })]), 50);
    expect(out[0].files).toEqual(['old/name.ts → new/name.ts']);
  });

  it('单提交文件数超上限：截断并标记', () => {
    const files = Array.from({ length: 6 }, (_, i) => `M\tf${i}.ts`);
    const out = parseSummaryLog(log([mk({ files })]), 3);
    expect(out[0].files).toEqual(['f0.ts', 'f1.ts', 'f2.ts']);
    expect(out[0].filesTruncated).toBe(true);
  });

  it('多提交按输出顺序解析；merge/非文件行被忽略', () => {
    const out = parseSummaryLog(log([
      mk({ sha: 'b'.repeat(40), short: 'bbbbbbb', files: ['M\tx.ts'] }),
      mk({ sha: 'c'.repeat(40), short: 'ccccccc', files: [] }),
    ]), 50);
    expect(out).toHaveLength(2);
    expect(out[1].files).toEqual([]);
  });

  it('空输出返回空数组', () => {
    expect(parseSummaryLog('', 50)).toEqual([]);
  });

  it('SUMMARY_FORMAT 为 5 字段 + 记录分隔符', () => {
    expect(SUMMARY_FORMAT.split('\x1f')).toHaveLength(5);
    expect(SUMMARY_FORMAT.endsWith('\x1e')).toBe(true);
  });

  // ---------- 八进制引号路径解码（core.quotepath=true 残留 / 特殊字符强制转义） ----------

  it('全角括号中文路径八进制转义解码为 UTF-8 文本', () => {
    // （新建）= EF BC 88 / E6 96 B0 / E5 BB BA / EF BC 89
    const out = parseSummaryLog(log([mk({ files: ['A\t"doc/\\357\\274\\210\\346\\226\\260\\345\\273\\272\\357\\274\\211.txt"'] })]), 50);
    expect(out[0].files).toEqual(['doc/（新建）.txt']);
  });

  it('重命名 R100 两端引号路径各自解码', () => {
    const out = parseSummaryLog(log([mk({ files: ['R100\t"\\346\\227\\247.ts"\t"\\346\\226\\260.ts"'] })]), 50);
    expect(out[0].files).toEqual(['旧.ts → 新.ts']);
  });

  it('unescapeGitPath：非引号输入原样返回；C 风格简单转义还原', () => {
    expect(unescapeGitPath('src/a.ts')).toBe('src/a.ts');
    expect(unescapeGitPath('"a\\tb\\nc\\\\d\\"e"')).toBe('a\tb\nc\\d"e');
    expect(unescapeGitPath('"')).toBe('"');   // 仅首引号不成对：原样
  });
});
