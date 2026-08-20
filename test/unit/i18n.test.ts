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
});
