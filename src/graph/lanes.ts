/**
 * Lane 分配算法（设计方案 5.2）——纯函数，Webview 侧调用，单测覆盖。
 *
 * 输入为 topo 序提交数组（子在前）。核心思想：维护一组"活跃 lane"，
 * 每条 lane 记录其期待的下一个提交 id（该支线将流向的父提交）。
 */
import type { Commit } from '../common/models';

export type CurveKind = 'fork' | 'mergeOut' | 'mergeIn';

export interface Curve {
  row: number;
  fromLane: number;
  toLane: number;
  kind: CurveKind;
}

export interface GraphData {
  laneCount: number;
  /** activeBelow[r]：第 r 行下方仍活跃的 lane 编号集合（对应一段竖线） */
  activeBelow: number[][];
  curves: Curve[];
}

export function computeLanes(commits: Commit[]): GraphData {
  const lanes: (string | null)[] = [];
  const activeBelow: number[][] = [];
  const curves: Curve[] = [];

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    c.row = i;

    // 1) 本提交被哪些 lane 期待（criss-cross 时可能多个）
    const hit: number[] = [];
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] === c.sha) hit.push(k);
    }
    let lane: number;
    if (hit.length > 0) {
      lane = hit[0];
      for (const h of hit) {
        if (h !== lane) {
          curves.push({ row: i, fromLane: h, toLane: lane, kind: 'mergeIn' });
          lanes[h] = null;
        }
      }
    } else {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    c.lane = lane;

    // 2) 安排父提交去向
    if (c.parents.length === 0) {
      lanes[lane] = null;
    } else {
      lanes[lane] = c.parents[0];
      for (let p = 1; p < c.parents.length; p++) {
        const parent = c.parents[p];
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          if (existing !== lane) {
            curves.push({ row: i, fromLane: lane, toLane: existing, kind: 'mergeOut' });
          }
        } else {
          let k = lanes.indexOf(null);
          if (k === -1) {
            k = lanes.length;
            lanes.push(null);
          }
          lanes[k] = parent;
          curves.push({ row: i, fromLane: lane, toLane: k, kind: 'fork' });
        }
      }
    }

    const act: number[] = [];
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] !== null) act.push(k);
    }
    activeBelow.push(act);
  }

  let laneCount = 0;
  for (const c of commits) laneCount = Math.max(laneCount, (c.lane ?? 0) + 1);
  for (const act of activeBelow) {
    for (const k of act) laneCount = Math.max(laneCount, k + 1);
  }
  return { laneCount, activeBelow, curves };
}
