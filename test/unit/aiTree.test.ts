import { describe, expect, it } from 'vitest';
import { buildFileTree, diffContentUsable, formatEntryList } from '../../src/ai/tree';

describe('buildFileTree（AI 路径级上下文）', () => {
  it('嵌套目录：目录序在前带计数、文件序在后带状态', () => {
    const tree = buildFileTree([
      { status: 'M', path: 'package.json' },
      { status: 'A', path: 'src/git/service.ts' },
      { status: 'M', path: 'src/ui/app/workView.ts' },
      { status: 'D', path: 'src/old.ts' },
    ]);
    const lines = tree.split('\n');
    expect(lines).toEqual([
      'src/ (3)',
      '  git/ (1)',
      '    service.ts (A)',
      '  ui/ (1)',
      '    app/ (1)',
      '      workView.ts (M)',
      '  old.ts (D)',
      'package.json (M)',
    ]);
  });

  it('空清单返回空串；超 400 行聚合截断', () => {
    expect(buildFileTree([])).toBe('');
    const many = Array.from({ length: 500 }, (_, i) => ({ status: 'M', path: `d${Math.floor(i / 5)}/f${i}.ts` }));
    const out = buildFileTree(many);
    expect(out.split('\n').length).toBeLessThanOrEqual(401);   // 400 行 + 聚合行
    expect(out).toContain('另有');
  });
});

describe('formatEntryList / diffContentUsable', () => {
  it('清单行格式：" M\\tpath"', () => {
    expect(formatEntryList([{ status: 'A', path: 'a.txt' }, { status: 'D', path: 'b/c.ts' }]))
      .toBe(' A\ta.txt\n D\tb/c.ts');
  });

  it('文件少（≤4）始终可用；多文件但内容全为省略标记则不可用', () => {
    expect(diffContentUsable('', 3)).toBe(true);
    const markerOnly = Array.from({ length: 10 }, () => 'diff --git a/x b/x\n(内容已省略：锁文件/产物，见文件统计)').join('\n');
    expect(diffContentUsable(markerOnly, 10)).toBe(false);
    expect(diffContentUsable('', 10)).toBe(false);
  });

  it('多文件但有足量真实内容则可用', () => {
    const real = 'diff --git a/s.ts b/s.ts\n' + Array.from({ length: 60 }, (_, i) => `+real changed line ${i} with enough content`).join('\n');
    expect(diffContentUsable(real, 10)).toBe(true);
  });
});
