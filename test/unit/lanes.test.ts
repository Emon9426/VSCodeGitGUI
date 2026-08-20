import { describe, expect, it } from 'vitest';
import { computeLanes } from '../../src/graph/lanes';
import type { Commit } from '../../src/common/models';

let seq = 0;
function mk(sha: string, parents: string[]): Commit {
  return {
    sha, shortSha: sha.slice(0, 7), parents,
    author: { name: 'a', email: 'a@b.c', date: '2026-08-19T10:00:00+08:00' },
    committer: { name: 'a', email: 'a@b.c', date: '2026-08-19T10:00:00+08:00' },
    subject: `c${seq++}`, body: '', refs: [],
  };
}

function lanesOf(commits: Commit[]) {
  return commits.map(c => c.lane);
}

describe('computeLanes', () => {
  it('线性历史：全部 lane 0', () => {
    const cs = [mk('c3', ['c2']), mk('c2', ['c1']), mk('c1', [])];
    const g = computeLanes(cs);
    expect(lanesOf(cs)).toEqual([0, 0, 0]);
    expect(g.laneCount).toBe(1);
    expect(g.activeBelow[0]).toEqual([{ lane: 0, seg: 0 }]);
    expect(g.activeBelow[2]).toEqual([]);
  });

  it('分支与合并：fork 出 lane1，合并时 mergeIn 收敛', () => {
    // topo: m, a3, b1, a2, a1
    const cs = [
      mk('m', ['a3', 'b1']),
      mk('a3', ['a2']),
      mk('b1', ['a2']),
      mk('a2', ['a1']),
      mk('a1', []),
    ];
    const g = computeLanes(cs);
    expect(lanesOf(cs)).toEqual([0, 0, 1, 0, 0]);
    // m 行 fork 到 lane1（新分支段 seg1）
    expect(g.curves).toContainEqual({ row: 0, fromLane: 0, toLane: 1, kind: 'fork', seg: 1 });
    // a2 行 lane1 汇入 lane0（沿用汇入支线自己的段色）
    expect(g.curves).toContainEqual({ row: 3, fromLane: 1, toLane: 0, kind: 'mergeIn', seg: 1 });
    expect(g.laneCount).toBe(2);
    expect(g.activeBelow[0]).toEqual([{ lane: 0, seg: 0 }, { lane: 1, seg: 1 }]);
    expect(g.activeBelow[2]).toEqual([{ lane: 0, seg: 0 }, { lane: 1, seg: 1 }]); // b1 行下方两条支线都期待 a2
    expect(g.activeBelow[3]).toEqual([{ lane: 0, seg: 0 }]);                       // a2 之后仅剩主支线
  });

  it('octopus 合并（3 父）：fork 两条新 lane', () => {
    const cs = [
      mk('m', ['x', 'y', 'z']),
      mk('x', ['r']), mk('y', ['r']), mk('z', ['r']),
      mk('r', []),
    ];
    const g = computeLanes(cs);
    expect(g.laneCount).toBe(3);
    const forks = g.curves.filter(c => c.kind === 'fork');
    expect(forks.length).toBe(2);
    // 第一父延续主支段 seg0，两条新支线各起新段
    expect(new Set(forks.map(f => f.seg).concat(cs[0].seg!))).toEqual(new Set([0, 1, 2]));
  });

  it('criss-cross：共享父提交被多条 lane 期待，在父行 mergeIn 收敛', () => {
    // 两个提交共用父 p：c2 走 lane0、c1 占 lane1，两条支线在 p 行收敛
    const cs = [
      mk('c2', ['p']),
      mk('c1', ['p']),
      mk('p', []),
    ];
    const g = computeLanes(cs);
    expect(cs[0].lane).toBe(0);
    expect(cs[1].lane).toBe(1);
    expect(g.activeBelow[1]).toEqual([{ lane: 0, seg: 0 }, { lane: 1, seg: 1 }]); // c1 行下方两条支线都期待 p
    expect(g.curves).toContainEqual({ row: 2, fromLane: 1, toLane: 0, kind: 'mergeIn', seg: 1 });
  });

  it('多根仓库：两条独立支线各占 lane', () => {
    const cs = [
      mk('a2', ['a1']), mk('b2', ['b1']),
      mk('a1', []), mk('b1', []),
    ];
    const g = computeLanes(cs);
    expect(lanesOf(cs)).toEqual([0, 1, 0, 1]);
    expect(g.laneCount).toBe(2);
  });

  it('按分支段着色：同槽位先后复用的两条分支 seg 不同', () => {
    // 场景：w（未合并分支尖）终止于 m1 后，同一 lane 槽位被 m1 的第二父 d3（新支线）复用
    const cs = [
      mk('m2', ['i', 'h']),   // lane0 主支 seg0；h fork lane1 seg1
      mk('i', ['m1']),        // lane0
      mk('w', ['m1']),        // 分支尖：占 lane2，起 seg2
      mk('m1', ['g', 'd3']),  // w 的 lane2 mergeIn 汇入；随后 fork 复用 lane2 给 d3 → 新 seg3
      mk('h', ['g']),         // lane1 延续 seg1，父 g 同时被 lane0 期待
      mk('d3', []),
      mk('g', []),
    ];
    const g = computeLanes(cs);
    expect(cs[2].seg).toBe(2);           // w = seg2
    expect(cs[5].seg).toBe(3);           // d3 = seg3，同 lane2 但不同段
    expect(g.curves).toContainEqual({ row: 3, fromLane: 2, toLane: 0, kind: 'mergeIn', seg: 2 });
    expect(g.curves).toContainEqual({ row: 3, fromLane: 0, toLane: 2, kind: 'fork', seg: 3 });
    expect(g.curves).toContainEqual({ row: 6, fromLane: 1, toLane: 0, kind: 'mergeIn', seg: 1 });
    // 节点段色连续性：主支全部 seg0
    expect([cs[0].seg, cs[1].seg, cs[3].seg, cs[6].seg]).toEqual([0, 0, 0, 0]);
  });
});
