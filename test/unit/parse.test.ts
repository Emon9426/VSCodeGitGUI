import { describe, expect, it } from 'vitest';
import {
  parseLog, parseDecorations, parseForEachRef, parseStatus, parseFiles, parseUnifiedDiff, countDiffLines,
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
