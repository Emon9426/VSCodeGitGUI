import { describe, expect, it } from 'vitest';
import { clampSummary } from '../../src/git/service';

describe('clampSummary 文件统计截断（AI prompt 防爆）', () => {
  it('少量文件原样保留', () => {
    const lines = [' +10/-2\tsrc/a.ts', ' B\timg/logo.png'];
    expect(clampSummary(lines)).toBe(lines.join('\n'));
  });

  it('超过 400 行封顶并聚合计数', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => ` +1/-0\tf${i}.ts`);
    const out = clampSummary(lines);
    expect(out.endsWith('…(另有 600 个文件未逐一列出)')).toBe(true);
    expect(out.split('\n')).toHaveLength(401);   // 400 行 + 聚合行
  });

  it('单行过长时按字符预算提前截断', () => {
    const long = ' +1/-0\t' + 'x'.repeat(200);
    const lines = Array.from({ length: 100 }, () => long);   // 100 行 ≈ 20K 字符 > 8K
    const out = clampSummary(lines);
    expect(out.length).toBeLessThanOrEqual(8_000 + 100);   // 预算 + 聚合行
    expect(out).toMatch(/…\(另有 \d+ 个文件未逐一列出\)/);
  });

  it('空列表返回空串', () => {
    expect(clampSummary([])).toBe('');
  });
});
