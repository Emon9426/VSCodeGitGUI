/**
 * Issue #24 图形范围单测：scopeStartRefs 由 refs 快照推导 git log 起点
 * （local=全部分支+仍存在的上游 / current=HEAD 分支+上游 / ref 精选直通 / 其余 null→--all）。
 */
import { describe, expect, it } from 'vitest';
import { scopeStartRefs, buildRefTree, type RawRef } from '../../src/git/parse';

const B = (name: string, upstream?: string) => ({ name, fullName: 'refs/heads/' + name, upstream });

const REMOTES = new Set(['refs/remotes/origin/main', 'refs/remotes/origin/feature/x']);

describe('scopeStartRefs：ref 精选直通（现状语义不变）', () => {
  it('ref 非空时忽略 scopeMode，直通该 ref', () => {
    expect(scopeStartRefs([B('main')], REMOTES, 'main', { ref: 'refs/remotes/origin/feature/x', scopeMode: 'local' }))
      .toEqual(['refs/remotes/origin/feature/x']);
    expect(scopeStartRefs([], new Set(), undefined, { ref: 'v1.0.0', scopeMode: 'current' }))
      .toEqual(['v1.0.0']);
  });
});

describe('scopeStartRefs：local = 本地分支 + 各自仍存在的上游', () => {
  it('含无上游的纯本地分支（决议 D1）；上游用全限定名', () => {
    const out = scopeStartRefs(
      [B('main', 'origin/main'), B('feature/x', 'origin/feature/x'), B('local-only')],
      REMOTES, 'main', { ref: null, scopeMode: 'local' },
    )!;
    expect(out).toContain('refs/heads/main');
    expect(out).toContain('refs/remotes/origin/main');
    expect(out).toContain('refs/heads/feature/x');
    expect(out).toContain('refs/remotes/origin/feature/x');
    expect(out).toContain('refs/heads/local-only');
    expect(out).toHaveLength(5);   // 多分支指向同一上游时 Set 去重
  });

  it('上游指向已 prune 的远端分支时剔除（防 unknown revision）', () => {
    const out = scopeStartRefs([B('main', 'origin/gone')], REMOTES, 'main', { ref: null, scopeMode: 'local' })!;
    expect(out).toEqual(['refs/heads/main']);
  });

  it('空仓库无分支 → null（回退 --all）', () => {
    expect(scopeStartRefs([], new Set(), undefined, { ref: null, scopeMode: 'local' })).toBeNull();
  });
});

describe('scopeStartRefs：current = 当前分支 + 其上游', () => {
  it('HEAD 分支含上游', () => {
    expect(scopeStartRefs([B('main', 'origin/main')], REMOTES, 'main', { ref: null, scopeMode: 'current' }))
      .toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
  });

  it('HEAD 分支无上游：仅本地分支', () => {
    expect(scopeStartRefs([B('dev')], REMOTES, 'dev', { ref: null, scopeMode: 'current' }))
      .toEqual(['refs/heads/dev']);
  });

  it('detached HEAD → HEAD（UI 侧另行提示）', () => {
    expect(scopeStartRefs([B('main')], REMOTES, undefined, { ref: null, scopeMode: 'current' }))
      .toEqual(['HEAD']);
  });

  it('HEAD 分支不在 branches 快照（竞态兜底）：按短名拼全限定', () => {
    expect(scopeStartRefs([B('other')], REMOTES, 'main', { ref: null, scopeMode: 'current' }))
      .toEqual(['refs/heads/main']);
  });
});

describe('scopeStartRefs：all / 未识别 → null（--all）', () => {
  it('all 与缺省 scopeMode 均返回 null', () => {
    expect(scopeStartRefs([B('main')], REMOTES, 'main', { ref: null, scopeMode: 'all' })).toBeNull();
    expect(scopeStartRefs([B('main')], REMOTES, 'main', { ref: null })).toBeNull();
  });
});

describe('buildRefTree：origin/HEAD 符号引用过滤（实机测试暴露的既有缺陷）', () => {
  it("git 的 refname:short 把 refs/remotes/origin/HEAD 剥成 'origin'——按全名过滤，不产生无意义 origin 行", () => {
    const refs: RawRef[] = [
      { prefix: 'refs/heads/', fullName: 'refs/heads/main', sha: 'a1', short: 'main' },
      { prefix: 'refs/remotes/', fullName: 'refs/remotes/origin/HEAD', sha: 'a1', short: 'origin' },   // 实测 git 2.49 输出
      { prefix: 'refs/remotes/', fullName: 'refs/remotes/origin/main', sha: 'a1', short: 'origin/main' },
    ];
    const { branches, remotes } = buildRefTree(refs, 'main');
    expect(branches).toHaveLength(1);
    expect(remotes).toHaveLength(1);
    expect(remotes[0]!.branches.map(b => b.name)).toEqual(['origin/main']);   // 无 'origin' 行
  });
});
