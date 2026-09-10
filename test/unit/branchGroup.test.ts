/**
 * Issue #24 / #23 分支前缀分组单测：首段 "/" 前缀分组、无前缀留顶层、组间字母序、组内保序。
 */
import { describe, expect, it } from 'vitest';
import { groupByPrefix } from '../../src/ui/app/branchGroup';

const N = (names: string[]) => names.map(n => ({ n }));

describe('groupByPrefix', () => {
  it('按首段前缀分组，无前缀留顶层', () => {
    const { top, groups } = groupByPrefix(N(['main', 'feature/login', 'feature/pay', 'bugfix/crash']), x => x.n);
    expect(top.map(x => x.n)).toEqual(['main']);
    expect(groups.map(g => g.prefix)).toEqual(['bugfix', 'feature']);
    expect(groups.find(g => g.prefix === 'feature')!.items.map(x => x.n)).toEqual(['feature/login', 'feature/pay']);
  });

  it('组间按前缀字母序；组内保持传入顺序', () => {
    const { groups } = groupByPrefix(N(['release/2.0', 'feature/a', 'hotfix/b', 'release/1.0', 'feature/c']), x => x.n);
    expect(groups.map(g => g.prefix)).toEqual(['feature', 'hotfix', 'release']);
    expect(groups.find(g => g.prefix === 'release')!.items.map(x => x.n)).toEqual(['release/2.0', 'release/1.0']);
  });

  it('仅二级以上前缀才分组：a/b/c 归组 a，非 a/b', () => {
    const { groups } = groupByPrefix(N(['a/b/c', 'a/b/d', 'a/e']), x => x.n);
    expect(groups).toHaveLength(1);
    expect(groups[0].prefix).toBe('a');
    expect(groups[0].items).toHaveLength(3);
  });

  it('尾斜杠/空串防御：留顶层不分组', () => {
    const { top, groups } = groupByPrefix(N(['trailing/', 'plain']), x => x.n);
    expect(top.map(x => x.n)).toEqual(['trailing/', 'plain']);
    expect(groups).toHaveLength(0);
  });

  it('空列表与全无前缀', () => {
    expect(groupByPrefix([], (x: any) => x)).toEqual({ top: [], groups: [] });
    const r = groupByPrefix(N(['x', 'y']), a => a.n);
    expect(r.top).toHaveLength(2);
    expect(r.groups).toHaveLength(0);
  });
});
