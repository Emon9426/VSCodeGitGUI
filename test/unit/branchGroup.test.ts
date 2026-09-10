/**
 * 分支前缀分组单测（Issue #24 / #23；v0.23.2 递归多级）：
 * 多段前缀逐级建树、无前缀留顶层、组间字母序、组内保序、空段防御、计数与短名剥离。
 */
import { describe, expect, it } from 'vitest';
import { buildPrefixTree, countNode, stripTo } from '../../src/ui/app/branchGroup';

const N = (names: string[]) => names.map(n => ({ n }));

describe('buildPrefixTree', () => {
  it('按首段前缀分组，无前缀留顶层', () => {
    const { top, root } = buildPrefixTree(N(['main', 'feature/login', 'feature/pay', 'bugfix/crash']), x => x.n);
    expect(top.map(x => x.n)).toEqual(['main']);
    expect(root.children.map(c => c.seg)).toEqual(['bugfix', 'feature']);
    const feat = root.children.find(c => c.seg === 'feature')!;
    expect(feat.items.map(x => x.n)).toEqual(['feature/login', 'feature/pay']);
  });

  it('多段前缀递归建树：release/1.0/x → release > 1.0', () => {
    const { root } = buildPrefixTree(N(['release/1.0/fix-a', 'release/1.0/fix-b', 'release/2.0/feat', 'release/hot']), x => x.n);
    expect(root.children).toHaveLength(1);
    const rel = root.children[0];
    expect(rel.seg).toBe('release');
    expect(rel.path).toBe('release');
    expect(rel.items.map(x => x.n)).toEqual(['release/hot']);   // 恰好终结在本层
    expect(rel.children.map(c => c.seg)).toEqual(['1.0', '2.0']);
    const g10 = rel.children[0];
    expect(g10.path).toBe('release/1.0');
    expect(g10.items.map(x => x.n)).toEqual(['release/1.0/fix-a', 'release/1.0/fix-b']);
    expect(g10.children).toHaveLength(0);
  });

  it('同级混合：组内直挂项与子组并存', () => {
    const { root } = buildPrefixTree(N(['a/b/c', 'a/b/d', 'a/e']), x => x.n);
    const a = root.children[0];
    expect(a.items.map(x => x.n)).toEqual(['a/e']);
    expect(a.children).toHaveLength(1);
    expect(a.children[0].items.map(x => x.n)).toEqual(['a/b/c', 'a/b/d']);
  });

  it('各层组间按段字母序；组内保持传入顺序', () => {
    const { root } = buildPrefixTree(N(['release/2.0/z', 'release/1.0/y', 'release/1.0/x', 'feature/a']), x => x.n);
    expect(root.children.map(c => c.seg)).toEqual(['feature', 'release']);
    const rel = root.children[1];
    expect(rel.children.map(c => c.seg)).toEqual(['1.0', '2.0']);
    expect(rel.children[0].items.map(x => x.n)).toEqual(['release/1.0/y', 'release/1.0/x']);
  });

  it('尾斜杠/前导斜杠/连续斜杠防御：留顶层不分组', () => {
    const { top, root } = buildPrefixTree(N(['trailing/', 'plain', '/lead', 'a//b']), x => x.n);
    expect(top.map(x => x.n)).toEqual(['trailing/', 'plain', '/lead', 'a//b']);
    expect(root.children).toHaveLength(0);
  });

  it('空列表与全无前缀', () => {
    expect(buildPrefixTree([], (x: any) => x).root.children).toHaveLength(0);
    const r = buildPrefixTree(N(['x', 'y']), a => a.n);
    expect(r.top).toHaveLength(2);
    expect(r.root.children).toHaveLength(0);
  });
});

describe('countNode / stripTo', () => {
  const tree = () => buildPrefixTree(N(['release/hot', 'release/1.0/a', 'release/1.0/b', 'release/2.0/c']), x => x.n);

  it('countNode 递归累计全部后代项', () => {
    const { root } = tree();
    const rel = root.children[0];
    expect(countNode(rel)).toBe(4);
    expect(countNode(rel.children[0])).toBe(2);
    expect(countNode(rel.children[1])).toBe(1);
  });

  it('stripTo 剥组前缀得短名；根组与不匹配名原样返回', () => {
    expect(stripTo('release', 'release/hot')).toBe('hot');
    expect(stripTo('release/1.0', 'release/1.0/a')).toBe('a');
    expect(stripTo('', 'main')).toBe('main');
    expect(stripTo('release', 'feature/x')).toBe('feature/x');
  });
});
