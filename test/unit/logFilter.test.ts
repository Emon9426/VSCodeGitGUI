/**
 * Issue #5 筛选链路单测：作者名校验/正则转义（git --author 按正则匹配 "Name <email>"）、
 * 作者日期窗口（本地时区日界，与列表显示 %ad 同口径）。
 */
import { describe, expect, it } from 'vitest';
import { cleanAuthorName, escapeAuthorRegex, safeAuthorName, dayBoundMs, authorDateWindow } from '../../src/git/service';
import type { Commit } from '../../src/common/models';

const mk = (iso: string): Commit => ({ author: { date: iso } } as unknown as Commit);

describe('cleanAuthorName：原文校验（Issue #5 白名单放宽）', () => {
  it('保留普通与含标点的真实作者名', () => {
    expect(cleanAuthorName('Emon')).toBe('Emon');
    expect(cleanAuthorName('Anna Müller')).toBe('Anna Müller');
    expect(cleanAuthorName("O'Brien")).toBe("O'Brien");
    expect(cleanAuthorName('张三')).toBe('张三');
    expect(cleanAuthorName('Smith, John')).toBe('Smith, John');          // 旧白名单丢弃 → 筛选失效
    expect(cleanAuthorName('dependabot[bot]')).toBe('dependabot[bot]');  // 同上
    expect(cleanAuthorName('John "JJ"')).toBe('John "JJ"');
    expect(cleanAuthorName('  前后空白  ')).toBe('前后空白');
  });

  it('拒绝空/纯空白/超长/含控制字符', () => {
    expect(cleanAuthorName('')).toBeNull();
    expect(cleanAuthorName('   ')).toBeNull();
    expect(cleanAuthorName('x'.repeat(101))).toBeNull();
    expect(cleanAuthorName('a\nb')).toBeNull();
    expect(cleanAuthorName('a\x00b')).toBeNull();
    expect(cleanAuthorName('a\x7fb')).toBeNull();
  });
});

describe('escapeAuthorRegex / safeAuthorName', () => {
  it('按 BRE 元字符集转义（\\ . * [ ^ $），其余保持字面', () => {
    expect(escapeAuthorRegex('dependabot[bot]')).toBe('dependabot\\[bot\\]');
    expect(escapeAuthorRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeAuthorRegex('x^y$z\\')).toBe('x\\^y\\$z\\\\');
    // ( ) + ? | { } 在 BRE 中本就是字面量，转义反而变运算符——必须原样保留
    expect(escapeAuthorRegex('(x)+?|{}')).toBe('(x)+?|{}');
    expect(escapeAuthorRegex('Jean-Luc (JL)')).toBe('Jean-Luc (JL)');
    expect(escapeAuthorRegex('普通名字-ZZ_09')).toBe('普通名字-ZZ_09');   // 非元字符不动
  });

  it('safeAuthorName = 校验 + 转义（供 --author= 拼接）', () => {
    expect(safeAuthorName('Smith, John')).toBe('Smith, John');
    expect(safeAuthorName('dependabot[bot]')).toBe('dependabot\\[bot\\]');
    expect(safeAuthorName('a.b*c')).toBe('a\\.b\\*c');
    expect(safeAuthorName('')).toBeNull();
    expect(safeAuthorName('a\nb')).toBeNull();
  });
});

describe('dayBoundMs：本地时区日界', () => {
  it('YYYY-MM-DD → 当日 00:00:00.000 / 23:59:59.999（本地）', () => {
    expect(dayBoundMs('2026-09-01', false)).toBe(new Date(2026, 8, 1, 0, 0, 0, 0).getTime());
    expect(dayBoundMs('2026-09-01', true)).toBe(new Date(2026, 8, 1, 23, 59, 59, 999).getTime());
    expect(dayBoundMs('2026-02-30', false)).toBe(new Date(2026, 2, 2).getTime());   // JS 进位（3 月 2 日），无害
  });

  it('非法格式返回 undefined', () => {
    expect(dayBoundMs('', false)).toBeUndefined();
    expect(dayBoundMs('2026/09/01', false)).toBeUndefined();
    expect(dayBoundMs('2026-9-1', false)).toBeUndefined();
    expect(dayBoundMs('2026-09-01T00:00:00', false)).toBeUndefined();
  });
});

describe('authorDateWindow：作者日期窗口过滤', () => {
  it('两端均缺省 → 无窗口', () => {
    expect(authorDateWindow('', '')).toBeUndefined();
    expect(authorDateWindow('bad', 'bad')).toBeUndefined();
  });

  it('窗口按作者日期（含时区偏移解析）保留/排除', () => {
    const w = authorDateWindow('2026-01-01', '2026-01-31')!;
    expect(w.contains(mk('2026-01-15T10:00:00+08:00'))).toBe(true);   // 窗口内（rebase 型：作者旧）
    expect(w.contains(mk('2026-01-31T23:59:59+08:00'))).toBe(true);   // 截止日末端含
    expect(w.contains(mk('2026-01-31T23:59:59.999+08:00'))).toBe(true);
    expect(w.contains(mk('2026-02-01T00:00:00+08:00'))).toBe(false);  // 次日零点排除
    expect(w.contains(mk('2025-12-31T23:59:59+08:00'))).toBe(false);  // 起始日前排除
    // 提交者日期在窗口、作者日期不在（git --since 按提交者日期时的错位方向）→ 按作者日期排除
    expect(w.contains(mk('2026-01-15T10:00:00+08:00'))).toBe(true);
  });

  it('跨时区偏移按绝对时刻比较', () => {
    const w = authorDateWindow('2026-01-01', '2026-01-01')!;   // 单日窗口（本地）
    const dayStart = new Date(2026, 0, 1).getTime();
    const dayEnd = new Date(2026, 0, 1, 23, 59, 59, 999).getTime();
    expect(w.contains(mk(new Date(dayStart + 1).toISOString()))).toBe(true);
    expect(w.contains(mk(new Date(dayEnd - 1).toISOString()))).toBe(true);
    expect(w.contains(mk(new Date(dayEnd + 1).toISOString()))).toBe(false);
    expect(w.contains(mk(new Date(dayStart - 1).toISOString()))).toBe(false);
  });

  it('日期解析失败宁可保留', () => {
    const w = authorDateWindow('2026-01-01', '2026-01-31')!;
    expect(w.contains(mk(''))).toBe(true);
    expect(w.contains(mk('not-a-date'))).toBe(true);
    expect(w.contains({} as Commit)).toBe(true);   // author 缺失
  });

  it('只有一端时单边生效', () => {
    const sinceOnly = authorDateWindow('2026-08-01', '')!;
    expect(sinceOnly.contains(mk('2026-07-31T23:59:59+08:00'))).toBe(false);
    expect(sinceOnly.contains(mk('2026-12-31T00:00:00+08:00'))).toBe(true);
    const untilOnly = authorDateWindow('', '2026-08-01')!;
    expect(untilOnly.contains(mk('2026-08-02T00:00:00+08:00'))).toBe(false);
    expect(untilOnly.contains(mk('2020-01-01T00:00:00+08:00'))).toBe(true);
  });
});
