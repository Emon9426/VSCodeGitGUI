/**
 * Issue #24 提交行徽标单测：本地⑂/远程⇅前缀、HEAD 醒目 current 类、
 * 同名本地存在时远程降淡、远程徽标开关与标签截断（既有行为回归）。
 */
import { describe, expect, it } from 'vitest';
import { chipModels, remoteHasLocal } from '../../src/ui/app/chips';
import type { Commit, RefChip } from '../../src/common/models';

const C = (refs: RefChip[]): Commit => ({ refs } as unknown as Commit);
const local = (name: string): RefChip => ({ name, kind: 'head' });
const remote = (name: string): RefChip => ({ name, kind: 'remote' });
const tag = (name: string): RefChip => ({ name, kind: 'tag' });

describe('chipModels 前缀与醒目', () => {
  it('本地 ⑂ 前缀；远程 ⇅ 前缀；HEAD 徽标 current 类', () => {
    // refs 顺序由上游 parseDecorations 排好（HEAD → 本地 → 远程 → 标签），chipModels 保持传入序
    const out = chipModels(C([
      { name: 'main', kind: 'head', isHead: true }, local('main'), remote('origin/dev'),
    ]), { showRemoteChips: true, maxTagChips: 2 });
    expect(out[0]).toEqual({ cls: 'gg-chip head current', text: 'HEAD → main', title: 'main' });
    expect(out[1]).toEqual({ cls: 'gg-chip head', text: '⑂ main', title: 'main' });
    expect(out[2]).toEqual({ cls: 'gg-chip remote', text: '⇅ origin/dev', title: 'origin/dev' });
  });

  it('detached HEAD 徽标：current 类，文本 HEAD', () => {
    const out = chipModels(C([{ name: 'HEAD', kind: 'head', isHead: true }]), { showRemoteChips: true, maxTagChips: 2 });
    expect(out[0]).toEqual({ cls: 'gg-chip head current', text: 'HEAD', title: 'HEAD' });
  });
});

describe('chipModels 降淡与开关', () => {
  it('远程分支存在同名本地分支时加 dim', () => {
    const out = chipModels(C([remote('origin/main')]), {
      showRemoteChips: true, maxTagChips: 2, localNames: new Set(['main']),
    });
    expect(out[0]!.cls).toBe('gg-chip remote dim');
  });

  it('showRemoteChips=false 时远程徽标整体隐藏；标签照常显示在说明部分（决议 D4）', () => {
    const out = chipModels(C([remote('origin/main'), local('main'), tag('v1.0')]), { showRemoteChips: false, maxTagChips: 2 });
    expect(out).toHaveLength(2);
    expect(out.find(x => x.cls.includes('remote'))).toBeUndefined();
    expect(out.find(x => x.cls.includes('tag'))!.text).toBe('v1.0');
  });

  it('标签超 maxTagChips 截断并聚合 +N（#45：剩余标签名进 title）', () => {
    const out = chipModels(C([tag('v1'), tag('v2'), tag('v3')]), { showRemoteChips: true, maxTagChips: 2 });
    expect(out.filter(x => x.cls.includes('tag'))).toHaveLength(3);   // v1 v2 + +1
    expect(out[out.length - 1]).toEqual({ cls: 'gg-chip tag more', text: '+1', title: 'v3' });
  });
});

describe('remoteHasLocal', () => {
  it('剥离首段 remote 名后命中本地名集合', () => {
    const set = new Set(['feature/x']);
    expect(remoteHasLocal('origin/feature/x', set)).toBe(true);
    expect(remoteHasLocal('origin/main', set)).toBe(false);
    expect(remoteHasLocal('plain', set)).toBe(false);   // 无斜杠防御
    expect(remoteHasLocal('origin/feature/x', undefined)).toBe(false);
  });
});
