import { describe, expect, it } from 'vitest';
import { parseMergeResult, serializeMergeResult, totalLinesOf } from '../../src/ui/merge/parse';

function block(mine: string[], theirs: string[], mineLabel = 'HEAD', theirsLabel = 'origin/x'): string[] {
  return ['<<<<<<< ' + mineLabel, ...mine, '=======', ...theirs, '>>>>>>> ' + theirsLabel];
}

describe('parseMergeResult', () => {
  it('无标记：整文单公共段，hasMarkers=false', () => {
    const p = parseMergeResult('a\nb\nc');
    expect(p.hasMarkers).toBe(false);
    expect(p.chunks).toHaveLength(0);
    expect(p.segs).toHaveLength(1);
    expect(p.segs[0]).toEqual({ type: 'common', lines: ['a', 'b', 'c'] });
  });

  it('单块：公共段前后 + mine/theirs 分段与标签', () => {
    const text = ['top', ...block(['m1', 'm2'], ['t1']), 'tail', ''].join('\n');
    const p = parseMergeResult(text);
    expect(p.hasMarkers).toBe(true);
    expect(p.chunks).toHaveLength(1);
    const c = p.chunks[0];
    expect(c.mineLines).toEqual(['m1', 'm2']);
    expect(c.theirsLines).toEqual(['t1']);
    expect(c.mineLabel).toBe('HEAD');
    expect(c.theirsLabel).toBe('origin/x');
    expect(p.segs.map(s => s.type)).toEqual(['common', 'conflict', 'common']);
  });

  it('多块按顺序编号，连续两块无公共夹层', () => {
    const text = [...block(['a'], ['b']), ...block(['c'], ['d']), ''].join('\n');
    const p = parseMergeResult(text);
    expect(p.chunks.map(c => c.index)).toEqual([0, 1]);
    expect(p.segs[0].type).toBe('conflict');
    expect(p.segs[1].type).toBe('conflict');
  });

  it('diff3（||||||| base 段）被收集且不参与展示语义', () => {
    const text = ['<<<<<<< HEAD', 'mine', '||||||| base', 'old', '=======', 'theirs', '>>>>>>> x', ''].join('\n');
    const p = parseMergeResult(text);
    expect(p.chunks[0].baseLines).toEqual(['old']);
    expect(p.chunks[0].mineLines).toEqual(['mine']);
    expect(p.chunks[0].theirsLines).toEqual(['theirs']);
  });

  it('CRLF：eol 判定 \r\n，内部行剥离 \r，序列化恢复', () => {
    const text = ['a', ...block(['m'], ['t']), 'z', ''].join('\r\n');
    const p = parseMergeResult(text);
    expect(p.eol).toBe('\r\n');
    expect(p.chunks[0].mineLines).toEqual(['m']);
    const back = serializeMergeResult(p, new Map([[0, ['m']]]));   // 块已解决（用 mine）→ 无标记
    expect(back).toBe('a\r\nm\r\nz\r\n');
    expect(back.includes('\r\n')).toBe(true);
  });

  it('尾部无换行保真（split 尾空串语义）', () => {
    const p = parseMergeResult('a\nb');
    expect(serializeMergeResult(p, new Map())).toBe('a\nb');
  });

  it('BOM：记录并在序列化时恢复', () => {
    const p = parseMergeResult('\uFEFFa\nb\n');
    expect(p.bom).toBe(true);
    expect(serializeMergeResult(p, new Map())).toBe('\uFEFFa\nb\n');
  });

  it('标记未闭合（外部截断）：残余并入 mine 段容错', () => {
    const text = ['<<<<<<< HEAD', 'm1', '=======', 't1'].join('\n');
    const p = parseMergeResult(text);
    expect(p.chunks).toHaveLength(1);
    expect(p.chunks[0].theirsLines).toEqual(['t1']);
  });

  it('普通文本中类似标记（>7 个字符）不误判', () => {
    const p = parseMergeResult('<<<<<<<< HEAD\n=======');
    // 8 个 < 不匹配 RE_START；7 个 = 的 RE_SEP 只在块内生效
    expect(p.hasMarkers).toBe(false);
  });
});

describe('serializeMergeResult', () => {
  it('未解决块按原始标记与标签重建（部分进度安全落盘）', () => {
    const text = ['top', ...block(['m1'], ['t1']), 'tail', ''].join('\n');
    const p = parseMergeResult(text);
    const out = serializeMergeResult(p, new Map());   // 0 块已解决
    expect(out).toBe(text);
  });

  it('已解决块写为普通行，多个块混合（未解决块保留标记）', () => {
    const text = [...block(['a1'], ['b1']), 'mid', ...block(['a2'], ['b2']), ''].join('\n');
    const p = parseMergeResult(text);
    const out = serializeMergeResult(p, new Map([[0, ['picked']]]));
    expect(out.startsWith('picked\nmid\n')).toBe(true);
    expect(out.includes('<<<<<<< HEAD')).toBe(true);   // 第二块未解决，标记重建
  });

  it('块三选一/编辑结果替换与还原', () => {
    const text = ['top', ...block(['m1', 'm2'], ['t1', 't2']), ''].join('\n');
    const p = parseMergeResult(text);
    expect(serializeMergeResult(p, new Map([[0, ['m1', 'm2']]]))).toBe('top\nm1\nm2\n');
    expect(serializeMergeResult(p, new Map([[0, ['t1', 't2']]]))).toBe('top\nt1\nt2\n');
    expect(serializeMergeResult(p, new Map([[0, ['m1', 'm2', 't1', 't2']]]))).toBe('top\nm1\nm2\nt1\nt2\n');
    expect(serializeMergeResult(p, new Map([[0, []]]))).toBe('top\n');   // 都不要：块删空，尾空串保留
  });
});

describe('totalLinesOf', () => {
  it('公共 + 各块结果行数', () => {
    const text = ['a', ...block(['m1', 'm2'], ['t1']), 'b', ''].join('\n');
    const p = parseMergeResult(text);
    expect(totalLinesOf(p, new Map())).toBe(3 + 2);      // 公共 3 行（a、b、尾空串）+ mine 2
    expect(totalLinesOf(p, new Map([[0, ['x']]]))).toBe(3 + 1);
  });
});
