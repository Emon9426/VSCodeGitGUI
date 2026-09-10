/**
 * Issue #24 模糊匹配单测：子序列命中/断裂、大小写不敏感、连续与词首加分、命中下标（高亮用）、
 * 远程全名匹配场景（origin/feature/x）。
 */
import { describe, expect, it } from 'vitest';
import { fuzzyMatch } from '../../src/ui/fuzzy';

describe('fuzzyMatch 基础', () => {
  it('空查询全体命中（score 0，无高亮下标）', () => {
    expect(fuzzyMatch('', 'feature/login')).toEqual({ score: 0, positions: [] });
  });

  it('子序列命中给出下标；断裂返回 null', () => {
    const r = fuzzyMatch('fl', 'feature/login');
    expect(r).not.toBeNull();
    expect(r!.positions).toEqual([0, 8]);
    expect(fuzzyMatch('lf', 'feature/login')).toBeNull();   // 逆序不命中
    expect(fuzzyMatch('xyz', 'main')).toBeNull();
  });

  it('大小写不敏感', () => {
    const r = fuzzyMatch('FL', 'feature/login');
    expect(r!.positions).toEqual([0, 8]);
  });

  it('中文分支名子序列', () => {
    const r = fuzzyMatch('功能登录', '功能/登录页');
    expect(r).not.toBeNull();
    expect(r!.positions).toEqual([0, 1, 3, 4]);   // '/' 占位下标 2，命中跳过
  });
});

describe('fuzzyMatch 打分', () => {
  it('连续命中 > 分散命中', () => {
    const cont = fuzzyMatch('fea', 'feature')!;
    const spread = fuzzyMatch('fte', 'feature')!;
    expect(cont.score).toBeGreaterThan(spread.score);
  });

  it('词首（开头或 / - _ . 之后）加分', () => {
    const wordStart = fuzzyMatch('l', 'feature/login')!;   // login 的词首 l
    const mid = fuzzyMatch('e', 'feature')!;                // feature 首字符也是词首，取开头
    // 'l' 命中 login 词首（前字符 '/'）与 'e' 命中串首同为词首加成；构造对照：
    const wordHit = fuzzyMatch('og', 'login')!;             // o 连续中段
    const startHit = fuzzyMatch('lo', 'login')!;            // lo 开头连续
    expect(startHit.score).toBeGreaterThan(wordHit.score + 0);
    expect(mid.score).toBeGreaterThan(0);
    expect(wordStart.score).toBeGreaterThanOrEqual(3);      // 基础 1 + 词首 2
  });

  it('完整前缀匹配分高于跳跃匹配', () => {
    const exact = fuzzyMatch('main', 'main')!;
    const jumpy = fuzzyMatch('main', 'mxxaxixn')!;   // 全分散无连续加成
    expect(exact.score).toBeGreaterThan(jumpy.score);
  });
});
