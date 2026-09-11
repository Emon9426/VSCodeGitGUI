import { describe, expect, it } from 'vitest';
import { dicts, createT } from '../../src/common/i18n';

describe('i18n 双语字典', () => {
  it('zh 与 en 键集合完全相等（防加键漏翻）', () => {
    const zh = new Set(Object.keys(dicts['zh-CN']));
    const en = new Set(Object.keys(dicts.en));
    const onlyZh = [...zh].filter(k => !en.has(k));
    const onlyEn = [...en].filter(k => !zh.has(k));
    expect(onlyZh, `仅 zh 有的键: ${onlyZh.join(',')}`).toEqual([]);
    expect(onlyEn, `仅 en 有的键: ${onlyEn.join(',')}`).toEqual([]);
  });

  it('en 字典值不含残留中文（langZh 除外——语言名按惯例用自称）', () => {
    const leftovers = Object.entries(dicts.en)
      .filter(([k, v]) => k !== 'langZh' && /[\u4e00-\u9fff]/.test(v))
      .map(([k]) => k);
    expect(leftovers).toEqual([]);
  });

  it('createT 参数替换与回退', () => {
    const t = createT('zh-CN');
    expect(t('fetchUpdated', { n: 3 })).toBe('获取完成：3 个分支引用有更新');
    const en = createT('en');
    expect(en('langEn')).toBe('English');
    expect(en('langZh')).toContain('Chinese');
  });

  it('复数占位 {k^单数|复数}：=1 取单数、其余取复数（#35）；中文键普通 {n} 不受影响', () => {
    const en = createT('en');
    expect(en('pullSummaryTitle', { n: 1 })).toBe('Pull summary — 1 new commit');
    expect(en('pullSummaryTitle', { n: 3 })).toBe('Pull summary — 3 new commits');
    expect(en('pullSummaryCounts', { c: 3, a: 1, f: 2 })).toBe('3 commits · 1 author · 2 files');
    expect(en('pullSummaryGone', { n: 1 })).toContain('1 file is not');
    expect(en('pullSummaryGone', { n: 2 })).toContain('2 files are not');
    // 0 在英文习惯取复数
    expect(en('pullSummaryTitle', { n: 0 })).toBe('Pull summary — 0 new commits');
    const zh = createT('zh-CN');
    expect(zh('pullSummaryTitle', { n: 1 })).toBe('拉取摘要 — 1 个新提交');
    expect(zh('pullSummaryCounts', { c: 2, a: 1, f: 4 })).toBe('2 个提交 · 1 位作者 · 4 个文件');
  });
});
