import { describe, expect, it } from 'vitest';
import {
  parseLog, parseDecorations, parseForEachRef, parseStatus, parseStatusEntries, parseStatusZ, parseFiles, parseUnifiedDiff, countDiffLines, semanticToOurs,
} from '../../src/git/parse';

const FS = '\x1f';
const RS = '\x1e';

function logRecord(sha: string, parents: string, decor: string, subject: string, body = ''): string {
  return [sha, sha.slice(0, 7), parents, '张三', 'z@x.y', '2026-08-19T10:00:00+08:00', '张三', 'z@x.y', '2026-08-19T10:00:00+08:00', decor, subject, body].join(FS) + RS;
}

describe('parseLog', () => {
  it('解析多记录（含中文、换行 body）', () => {
    const out = logRecord('aaa', 'bbb ccc', 'HEAD -> main', '首个提交') + '\n' + logRecord('bbb', '', '', 'root\n正文第二行', '更多正文');
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe('aaa');
    expect(commits[0].parents).toEqual(['bbb', 'ccc']);
    expect(commits[0].subject).toBe('首个提交');
    expect(commits[0].author.name).toBe('张三');
    expect(commits[1].body).toBe('更多正文');
  });

  it('空输出返回空数组', () => {
    expect(parseLog('')).toEqual([]);
  });
});

describe('parseDecorations', () => {
  it('HEAD -> 分支 / 远程 / 标签，按优先级排序', () => {
    const chips = parseDecorations('HEAD -> dev, origin/dev, tag: v1.0, other-branch', {
      localBranches: new Set(['dev', 'other-branch']),
      remoteBranches: new Set(['origin/dev']),
    });
    expect(chips.map(c => c.name)).toEqual(['dev', 'other-branch', 'origin/dev', 'v1.0']);
    expect(chips[0].isHead).toBe(true);
    expect(chips[0].kind).toBe('head');
    expect(chips[2].kind).toBe('remote');
    expect(chips[3].kind).toBe('tag');
  });

  it('分离 HEAD：仅 HEAD 装饰', () => {
    const chips = parseDecorations('HEAD');
    expect(chips).toEqual([{ name: 'HEAD', kind: 'head', isHead: true }]);
  });
});

describe('parseForEachRef', () => {
  it('annotated tag peel 到 commit sha；upstream track 解析', () => {
    const line = [
      'refs/tags/v2.0', 'tagobjsha', 'commitsha', 'v2.0', '', '', 'release', '2026-08-01T00:00:00+08:00', '李四',
    ].join('\x00');
    const refs = parseForEachRef(line);
    expect(refs).toHaveLength(1);
    expect(refs[0].sha).toBe('commitsha');

    const branch = [
      'refs/heads/main', 'c1', '', 'main', 'origin/main', 'ahead 1, behind 2', 's', '2026-08-01T00:00:00+08:00', 'a',
    ].join('\x00');
    const b = parseForEachRef(branch)[0];
    expect(b.trackAhead).toBe(1);
    expect(b.trackBehind).toBe(2);
    expect(b.upstream).toBe('origin/main');
  });
});

describe('parseStatus', () => {
  it('含 ahead/behind 的分支行 + 脏文件计数', () => {
    const out = '## main...origin/main [ahead 1, behind 2]\n M a.ts\n?? b.txt\n';
    const st = parseStatus(out);
    expect(st.branch).toBe('main');
    expect(st.upstream).toBe('origin/main');
    expect(st.ahead).toBe(1);
    expect(st.behind).toBe(2);
    expect(st.dirtyCount).toBe(2);
    expect(st.detached).toBe(false);
  });

  it('分离 HEAD 与空仓库', () => {
    expect(parseStatus('## HEAD (no branch)\n').detached).toBe(true);
    const empty = parseStatus('## No commits yet on main\n');
    expect(empty.noCommitsYet).toBe(true);
    expect(empty.branch).toBe('main');
  });
});

describe('parseFiles / parseUnifiedDiff', () => {
  it('name-status 与 numstat 按行 zip（含重命名与二进制）', () => {
    const ns = ['A\tnew.ts', 'R100\told.ts\trenamed.ts', 'D\tgone.bin'].join('\n');
    const num = ['10\t0\tnew.ts', '3\t1\told.ts => renamed.ts', '-\t-\tgone.bin'].join('\n');
    const files = parseFiles(ns, num);
    expect(files).toEqual([
      { status: 'A', path: 'new.ts', oldPath: undefined, additions: 10, deletions: 0 },
      { status: 'R', path: 'renamed.ts', oldPath: 'old.ts', additions: 3, deletions: 1 },
      { status: 'D', path: 'gone.bin', oldPath: undefined, additions: undefined, deletions: undefined },
    ]);
  });

  it('unified diff 解析：hunk 头、增删行号、no-newline 忽略', () => {
    const text = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,4 @@',
      ' ctx',
      '-del',
      '+add1',
      '+add2',
      '\\ No newline at end of file',
    ].join('\n');
    expect(countDiffLines(text)).toBe(5);
    const d = parseUnifiedDiff(text);
    expect(d.hunks).toHaveLength(1);
    const h = d.hunks[0];
    expect(h.oldStart).toBe(1);
    expect(h.newStart).toBe(1);
    expect(h.lines.map(l => l.kind)).toEqual(['ctx', 'del', 'add', 'add']);
    expect(h.lines[1].oldNo).toBe(2);
    expect(h.lines[2].newNo).toBe(2);
    expect(h.lines.every(l => l.text !== undefined)).toBe(true);
  });
});

describe('parseStatusEntries（porcelain -z 状态矩阵）', () => {
  const NUL = '\0';
  it('XY 双列码 → staged/unstaged/untracked 派生', () => {
    const out = [
      'M  src/a.ts',       // 仅已暂存
      ' M src/b.ts',       // 仅未暂存
      'MM src/c.ts',       // 双态：两组各一行
      'A  new.ts',         // 已暂存新增
      'D  gone.ts',        // 已暂存删除
      '?? notes.md',       // 未跟踪
      ' D del2.ts',        // 未暂存删除
    ].map(s => s + NUL).join('');
    const { entries, merging } = parseStatusEntries(out);
    expect(merging).toBe(false);
    const by = (p: string) => entries.find(e => e.path === p)!;
    expect(by('src/a.ts')).toMatchObject({ staged: 'M', unstaged: null, untracked: false });
    expect(by('src/b.ts')).toMatchObject({ staged: null, unstaged: 'M' });
    expect(by('src/c.ts')).toMatchObject({ staged: 'M', unstaged: 'M' });
    expect(by('new.ts')).toMatchObject({ staged: 'A' });
    expect(by('gone.ts')).toMatchObject({ staged: 'D' });
    expect(by('notes.md')).toMatchObject({ staged: null, unstaged: null, untracked: true });
    expect(by('del2.ts')).toMatchObject({ staged: null, unstaged: 'D' });
    expect(entries).toHaveLength(7);
  });

  it('重命名 R：origPath 取后续 NUL 记录', () => {
    const out = 'R  src/new.ts' + NUL + 'lib/old.ts' + NUL + '?? x' + NUL;
    const { entries } = parseStatusEntries(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: 'src/new.ts', origPath: 'lib/old.ts', staged: 'R' });
    expect(entries[1]).toMatchObject({ path: 'x', untracked: true });
  });

  it('冲突状态标记 merging 与 conflict（独立分组，不入暂存矩阵）', () => {
    const out = 'UU both.ts' + NUL + 'DD dd.ts' + NUL + 'AA aa.ts' + NUL;
    const { entries, merging } = parseStatusEntries(out);
    expect(merging).toBe(true);
    expect(entries[0]).toMatchObject({ path: 'both.ts', staged: null, unstaged: null, conflict: true });
    expect(entries[1]).toMatchObject({ path: 'dd.ts', conflict: true });
    expect(entries[2]).toMatchObject({ path: 'aa.ts', conflict: true });
  });

  it('路径含空格/中文正常（-z 无引号转义）', () => {
    const out = 'M  my file 名.md' + NUL;
    const { entries } = parseStatusEntries(out);
    expect(entries[0].path).toBe('my file 名.md');
  });

  it('空输出与忽略条目', () => {
    expect(parseStatusEntries('')).toEqual({ entries: [], merging: false });
    const { entries } = parseStatusEntries('!! ignored/' + NUL);
    expect(entries).toHaveLength(0);
  });
});

describe('parseStatusZ（-z -b 一次解析：分支头 + 文件矩阵）', () => {
  const NUL = '\0';
  it('分支头 + 条目：info 与 entries 同时产出，dirtyCount 按条目数计', () => {
    const out = '## main...origin/main [ahead 1, behind 2]' + NUL
      + 'M  src/a.ts' + NUL + 'MM src/b.ts' + NUL + '?? x.md' + NUL;
    const { info, entries, merging } = parseStatusZ(out);
    expect(info.branch).toBe('main');
    expect(info.upstream).toBe('origin/main');
    expect(info.ahead).toBe(1);
    expect(info.behind).toBe(2);
    expect(info.dirtyCount).toBe(3);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ path: 'src/a.ts', staged: 'M' });
    expect(entries[1]).toMatchObject({ path: 'src/b.ts', staged: 'M', unstaged: 'M' });
    expect(entries[2]).toMatchObject({ path: 'x.md', untracked: true });
    expect(merging).toBe(false);
  });

  it('分离 HEAD / 无提交 / 冲突标记', () => {
    const detached = parseStatusZ('## HEAD (no branch)' + NUL + 'A  a.ts' + NUL);
    expect(detached.info.detached).toBe(true);
    expect(detached.info.dirtyCount).toBe(1);
    const empty = parseStatusZ('## No commits yet on main' + NUL);
    expect(empty.info.noCommitsYet).toBe(true);
    expect(empty.entries).toEqual([]);
    expect(empty.info.dirtyCount).toBe(0);
    const conflict = parseStatusZ('## main' + NUL + 'UU c.txt' + NUL);
    expect(conflict.merging).toBe(true);
  });

  it('重命名条目（R 双记录不误吞后续条目）', () => {
    const out = '## main' + NUL + 'R  n.ts' + NUL + 'old.ts' + NUL + '?? z' + NUL;
    const { entries } = parseStatusZ(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ path: 'n.ts', origPath: 'old.ts', staged: 'R' });
    expect(entries[1]).toMatchObject({ path: 'z', untracked: true });
  });

  it('无分支头（纯条目）也可解析', () => {
    const { info, entries } = parseStatusZ('M  a' + NUL);
    expect(info.branch).toBeUndefined();
    expect(entries).toHaveLength(1);
  });
});

describe('semanticToOurs 语义侧→git ours 映射（v0.18.1 修复回归）', () => {
  // merge：我=stage2=--ours；rebase：我=stage3=--theirs（git 视角反转）
  it('merge 场景四象限', () => {
    expect(semanticToOurs('merge', false)).toBe(true);    // 选我的 → --ours
    expect(semanticToOurs('merge', true)).toBe(false);    // 选他人的 → --theirs
  });
  it('rebase 场景四象限（语义反转）', () => {
    expect(semanticToOurs('rebase', false)).toBe(false);  // 选我的（重放提交=:3）→ --theirs
    expect(semanticToOurs('rebase', true)).toBe(true);    // 选他人的（基底=:2）→ --ours
  });
  it('other 场景按 merge 语义', () => {
    expect(semanticToOurs('other', false)).toBe(true);
    expect(semanticToOurs('other', true)).toBe(false);
  });
});
