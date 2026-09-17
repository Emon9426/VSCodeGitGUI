/**
 * fillScan 纯函数单元测试（Issue #12：补扫凑页编排从 panel 抽出）：
 * 凑满即停（产出可超额 ≤ 2×limit−1）/ 扫尽 / CAP 截断 / 空页终止 / 游标单调推进 / 无死循环。
 */
import { describe, expect, it } from 'vitest';
import { fillScan } from '../../src/git/service';

/** 可编排假页源：按序消费脚本页（越界用尾页重复）；scanned 恒按 scanStep 推进（真实
 *  commitsPage 同款——CAP 判定依赖 scanned 相对 scanOffset 递增）；记录每轮收到的 scan */
function fakeFetcher(script: { commits: number; hasMore: boolean; scanStep: number }[], commitOf: (i: number) => string) {
  const seenScans: number[] = [];
  let total = 0;
  const fetchPage = async (scan: number) => {
    seenScans.push(scan);
    const p = script[Math.min(seenScans.length - 1, script.length - 1)];
    const commits = Array.from({ length: p.commits }, () => commitOf(total++));
    return { commits, hasMore: p.hasMore, scanned: scan + p.scanStep };
  };
  return { fetchPage, seenScans: () => seenScans };
}
const item = (i: number) => `c${i}`;

describe('fillScan（Issue #12）', () => {
  it('首页凑满即停：单轮调用，产出即首页', async () => {
    const f = fakeFetcher([{ commits: 10, hasMore: true, scanStep: 10 }], item);
    const r = await fillScan(f.fetchPage, 0, 10, 100);
    expect(r.commits).toHaveLength(10);
    expect(r.hasMore).toBe(true);
    expect(r.scanned).toBe(10);
    expect(f.seenScans()).toEqual([0]);
  });

  it('稀疏凑页：每轮 1 条 × limit 轮凑满，游标逐轮取上轮 scanned', async () => {
    const f = fakeFetcher([{ commits: 1, hasMore: true, scanStep: 5 }], item);
    const r = await fillScan(f.fetchPage, 0, 3, 100);
    expect(r.commits).toHaveLength(3);
    expect(r.scanned).toBe(15);
    expect(f.seenScans()).toEqual([0, 5, 10]);   // 每轮 scan 都来自上轮返回值（单调推进）
  });

  it('扫尽：hasMore=false 即停，产出全收', async () => {
    const f = fakeFetcher([
      { commits: 2, hasMore: true, scanStep: 50 },
      { commits: 1, hasMore: false, scanStep: 10 },
    ], item);
    const r = await fillScan(f.fetchPage, 0, 10, 100);
    expect(r.commits).toHaveLength(3);
    expect(r.hasMore).toBe(false);
    expect(r.scanned).toBe(60);
    expect(f.seenScans()).toHaveLength(2);
  });

  it('CAP 截断：达上限即停且如实返回 hasMore=true（前端续扫通道）', async () => {
    const f = fakeFetcher([{ commits: 0, hasMore: true, scanStep: 100 }], item);
    const r = await fillScan(f.fetchPage, 0, 500, 300);
    expect(r.commits).toHaveLength(0);
    expect(r.hasMore).toBe(true);
    expect(r.scanned).toBeGreaterThanOrEqual(300);
    expect(f.seenScans().length).toBeGreaterThanOrEqual(3);   // 无死循环：scan 相对推进即止
  });

  it('空页扫尽终止：空页且 hasMore=false 不再循环', async () => {
    const f = fakeFetcher([{ commits: 0, hasMore: false, scanStep: 40 }], item);
    const r = await fillScan(f.fetchPage, 40, 500, 300);
    expect(r.commits).toHaveLength(0);
    expect(r.hasMore).toBe(false);
    expect(r.scanned).toBe(80);
    expect(f.seenScans()).toEqual([40]);
  });

  it('产出可超额：末轮整页并入，≤ 2×limit−1', async () => {
    // limit=5：首页 1 条（未满），次页整页 5 条并入 → 6 ≤ 2×5−1
    const f = fakeFetcher([
      { commits: 1, hasMore: true, scanStep: 10 },
      { commits: 5, hasMore: true, scanStep: 10 },
    ], item);
    const r = await fillScan(f.fetchPage, 0, 5, 100);
    expect(r.commits).toHaveLength(6);
    expect(r.commits.length).toBeLessThanOrEqual(2 * 5 - 1);
  });

  it('非零起点续扫：scanOffset 传递并参与 CAP 判定（相对偏移）', async () => {
    const f = fakeFetcher([{ commits: 0, hasMore: true, scanStep: 10_000 }], item);
    const r = await fillScan(f.fetchPage, 20_000, 500, 20_000);
    expect(f.seenScans()[0]).toBe(20_000);
    expect(r.scanned - 20_000).toBeGreaterThanOrEqual(20_000);   // CAP 相对 scanOffset 判定
    expect(r.scanned - 20_000).toBeLessThan(20_000 + 10_000);    // 达限即停（无多余一轮）
  });
});
