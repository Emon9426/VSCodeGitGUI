/**
 * Lane 分配算法（设计方案 5.2）——纯函数，Webview 侧调用，单测覆盖。
 *
 * 输入为 topo 序提交数组（子在前）。核心思想：维护一组"活跃 lane"，
 * 每条 lane 记录其期待的下一个提交 id（该支线将流向的父提交）。
 *
 * 着色按"分支段"（seg）而非 lane 槽位：fork 新建支线时分配新 seg，
 * 同一槽位先后复用的两条不同分支因此获得不同颜色（GitGraph 风格）。
 */

import type { Commit } from '../common/models';

export type CurveKind = 'fork' | 'mergeOut' | 'mergeIn';

export interface Curve {
  row: number;
  fromLane: number;
  toLane: number;
  kind: CurveKind;
  /** 着色分支段：fork=新段；mergeIn=汇入段（来源支线）；mergeOut=目标段（被合并支线） */
  seg: number;
}

export interface ActiveLane {
  lane: number;
  seg: number;
}

export interface GraphData {
  laneCount: number;
  /** activeBelow[r]：第 r 行下方仍活跃的 lane 及其分支段（对应一段竖线） */
  activeBelow: ActiveLane[][];
  curves: Curve[];
  /** 分支段总数；取色用 colors[seg % colors.length] */
  segCount: number;
}

export function computeLanes(commits: Commit[]): GraphData {
  const lanes: (string | null)[] = [];
  const laneSeg: (number | null)[] = [];
  const activeBelow: ActiveLane[][] = [];
  const curves: Curve[] = [];
  let segCount = 0;

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
          curves.push({ row: i, fromLane: h, toLane: lane, kind: 'mergeIn', seg: laneSeg[h] ?? 0 });
          lanes[h] = null;
          laneSeg[h] = null;
        }
      }
    } else {
      lane = lanes.indexOf(null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
        laneSeg.push(null);
      }
      // 无支线接入（分支尖/首提交）：该 lane 起一条新分支段
      laneSeg[lane] = segCount++;
    }
    c.lane = lane;
    c.seg = laneSeg[lane] ?? 0;

    // 2) 安排父提交去向
    if (c.parents.length === 0) {
      lanes[lane] = null;
      laneSeg[lane] = null;
    } else {
      lanes[lane] = c.parents[0];
      laneSeg[lane] = c.seg; // 第一父线延续本段
      for (let p = 1; p < c.parents.length; p++) {
        const parent = c.parents[p];
        const existing = lanes.indexOf(parent);
        if (existing !== -1) {
          if (existing !== lane) {
            curves.push({ row: i, fromLane: lane, toLane: existing, kind: 'mergeOut', seg: laneSeg[existing] ?? 0 });
          }
        } else {
          let k = lanes.indexOf(null);
          if (k === -1) {
            k = lanes.length;
            lanes.push(null);
            laneSeg.push(null);
          }
          lanes[k] = parent;
          laneSeg[k] = segCount; // 第二父是新支线：新分支段
          segCount++;
          curves.push({ row: i, fromLane: lane, toLane: k, kind: 'fork', seg: segCount - 1 });
        }
      }
    }

    const act: ActiveLane[] = [];
    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k] !== null) act.push({ lane: k, seg: laneSeg[k] ?? 0 });
    }
    activeBelow.push(act);
  }

  let laneCount = 0;
  for (const c of commits) laneCount = Math.max(laneCount, (c.lane ?? 0) + 1);
  for (const act of activeBelow) {
    for (const k of act) laneCount = Math.max(laneCount, k.lane + 1);
  }
  return { laneCount, activeBelow, curves, segCount };
}
