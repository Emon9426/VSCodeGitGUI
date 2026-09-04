/**
 * Issue #5 筛选修复真实 git 集成测试（GITGRAPH_SMOKE=1 启用）：
 * 多作者（含 bot 方括号名/逗号名/引号名——旧字符白名单会静默丢弃）+ rebase 型日期偏斜
 * （作者日期 1 月 / 提交者日期 9 月——git --since 按提交者日期过滤时窗口错位）。
 * 验证：作者筛选命中、作者日期窗口口径、扫描游标（scanned ≠ 产出计数）续扫分页无缺无重。
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitExecutor } from '../../src/git/executor';
import { GitService, SCAN_CAP } from '../../src/git/service';

const enabled = !!process.env.GITGRAPH_SMOKE && spawnSync('git', ['--version']).status === 0;

interface Seed { name: string; email: string; ad: string; cd: string; msg: string; }
const SEEDS: Seed[] = [
  { name: 'Emon', email: 'emon@e.com', ad: '2026-08-20T10:00:00+08:00', cd: '2026-08-20T10:00:00+08:00', msg: 'A1 Emon normal' },
  { name: 'Anna Müller', email: 'anna@e.com', ad: '2026-08-21T10:00:00+08:00', cd: '2026-08-21T10:00:00+08:00', msg: 'A2 Anna umlaut' },
  { name: "O'Brien", email: 'ob@e.com', ad: '2026-08-22T10:00:00+08:00', cd: '2026-08-22T10:00:00+08:00', msg: "A3 O'Brien" },
  { name: '张三', email: 'zs@e.com', ad: '2026-08-23T10:00:00+08:00', cd: '2026-08-23T10:00:00+08:00', msg: 'A4 zhangsan' },
  { name: 'Smith, John', email: 'sj@e.com', ad: '2026-08-24T10:00:00+08:00', cd: '2026-08-24T10:00:00+08:00', msg: 'B1 comma name' },
  { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com', ad: '2026-08-25T10:00:00+08:00', cd: '2026-08-25T10:00:00+08:00', msg: 'B2 bot brackets' },
  { name: 'Jean-Luc (JL)', email: 'jl@e.com', ad: '2026-08-26T10:00:00+08:00', cd: '2026-08-26T10:00:00+08:00', msg: 'B3 parens name' },
  { name: 'Rebased Rachel', email: 'rr@e.com', ad: '2026-01-15T10:00:00+08:00', cd: '2026-09-02T10:00:00+08:00', msg: 'C1 authorJan15' },
  { name: 'Emon', email: 'emon@e.com', ad: '2026-01-20T10:00:00+08:00', cd: '2026-09-03T10:00:00+08:00', msg: 'C2 Emon authorJan20' },
];

describe.skipIf(!enabled)('Issue #5 筛选 git 集成', () => {
  let root: string;
  let svc: GitService;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-logfilter-'));
    svc = new GitService(new GitExecutor('git'));
    const g = (args: string[], env: Record<string, string> = {}) => {
      const r = spawnSync('git', args, { cwd: root, env: { ...process.env, ...env } });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${String(r.stderr)}`);
    };
    g(['init', '-b', 'main']);
    for (const s of SEEDS) {
      g(['commit', '--allow-empty', '-m', s.msg], {
        GIT_AUTHOR_NAME: s.name, GIT_AUTHOR_EMAIL: s.email, GIT_AUTHOR_DATE: s.ad,
        GIT_COMMITTER_NAME: s.name, GIT_COMMITTER_EMAIL: s.email, GIT_COMMITTER_DATE: s.cd,
      });
    }
  });

  const F = (over: Partial<{ ref: string | null; authors: string[]; since: string; until: string; noMerges: boolean }>) =>
    ({ ref: null, authors: [], since: '', until: '', noMerges: false, ...over });

  it('authorsOf 下拉候选包含全部作者（bot/逗号/引号名不丢）', async () => {
    const names = await svc.authorsOf(root);
    for (const want of ['Emon', 'Anna Müller', "O'Brien", '张三', 'Smith, John', 'dependabot[bot]', 'Jean-Luc (JL)', 'Rebased Rachel']) {
      expect(names, `下拉应含 ${want}`).toContain(want);
    }
  });

  it('作者筛选：旧白名单会静默丢弃的名字现在精确命中（Issue #5 主缺陷）', async () => {
    const subjects = async (authors: string[]) =>
      (await svc.commitsPage(root, F({ authors }), 0, 500)).commits.map(c => c.subject);
    expect(await subjects(['dependabot[bot]'])).toEqual(['B2 bot brackets']);
    expect(await subjects(['Smith, John'])).toEqual(['B1 comma name']);
    expect(await subjects(['Jean-Luc (JL)'])).toEqual(['B3 parens name']);
    expect(await subjects(['Emon'])).toEqual(['C2 Emon authorJan20', 'A1 Emon normal']);
    // 多选 OR
    expect(await subjects(['张三', 'Anna Müller'])).toEqual(['A4 zhangsan', 'A2 Anna umlaut']);
    // 全选不丢任何作者
    const all = await svc.commitsPage(root, F({ authors: SEEDS.map(s => s.name) }), 0, 500);
    expect(all.commits).toHaveLength(9);
  });

  it('日期窗口按作者日期（与列表显示同口径）：rebase 偏斜不再错位', async () => {
    const subjects = async (since: string, until: string) =>
      (await svc.commitsPage(root, F({ since, until }), 0, 500)).commits.map(c => c.subject);
    // 修复前（--since 按提交者日期）：此窗口返回空
    expect(await subjects('2026-01-01', '2026-01-31')).toEqual(['C2 Emon authorJan20', 'C1 authorJan15']);
    // 修复前：此窗口返回上面两条（界面却显示 1 月日期）
    expect(await subjects('2026-09-01', '2026-09-30')).toEqual([]);
    expect(await subjects('2026-08-24', '2026-08-26')).toEqual(['B3 parens name', 'B2 bot brackets', 'B1 comma name']);
    // 单边
    expect((await subjects('2026-08-27', '')).length).toBe(0);
    expect(await subjects('', '2026-08-19')).toEqual(['C2 Emon authorJan20', 'C1 authorJan15']);   // 单边 until：保留作者日期 ≤ 截止的提交
  });

  it('作者 + 日期组合', async () => {
    const r = await svc.commitsPage(root, F({ authors: ['Emon'], since: '2026-01-01', until: '2026-01-31' }), 0, 500);
    expect(r.commits.map(c => c.subject)).toEqual(['C2 Emon authorJan20']);
  });

  it('扫描游标：带窗口续扫（scanOffset≠产出计数）分页无缺无重', async () => {
    // 窗口命中 B1/B2/B3（3 条），它们位于扫描序（创建序倒排）第 4~6 行：
    // C2,C1,B3,B2,B1,A4,A3,A2,A1 —— 前两行（C2/C1）作者日期在 1 月被滤除
    const subjectsOf: string[] = [];
    let scan = 0;
    let hasMore = true;
    let calls = 0;
    while (hasMore && calls < 10) {
      const page = await svc.commitsPage(root, F({ since: '2026-08-24', until: '2026-08-26' }), scan, 2);
      subjectsOf.push(...page.commits.map(c => c.subject));
      expect(page.scanned).toBeGreaterThanOrEqual(scan);   // 游标单调推进
      scan = page.scanned;
      hasMore = page.hasMore;
      calls++;
    }
    expect(hasMore).toBe(false);                            // 9 条历史扫尽
    expect(scan).toBe(9);
    expect(subjectsOf).toEqual(['B3 parens name', 'B2 bot brackets', 'B1 comma name']);   // 精确 3 条，无缺无重
  });

  it('无窗口路径分页语义保持精确（git 侧过滤，回归保障）', async () => {
    const p1 = await svc.commitsPage(root, F({}), 0, 3);
    expect(p1.commits).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    expect(p1.scanned).toBe(3);
    const p2 = await svc.commitsPage(root, F({}), 3, 3);
    expect(p2.commits.map(c => c.subject)).not.toContain(p1.commits[0].subject);
    // 作者过滤（无窗口）分页语义与旧行为一致：页满即 hasMore=true（git 无法预知无更多匹配），
    // 续扫一页空 → hasMore=false 终止（前端空页终止自动加载依赖此语义）
    const ea = await svc.commitsPage(root, F({ authors: ['Emon'] }), 0, 2);
    expect(ea.commits).toHaveLength(2);
    expect(ea.hasMore).toBe(true);
    expect(ea.scanned).toBe(2);
    const ea2 = await svc.commitsPage(root, F({ authors: ['Emon'] }), 2, 2);
    expect(ea2.commits).toEqual([]);
    expect(ea2.hasMore).toBe(false);
  });

  it('SCAN_CAP 常量在合理量级（防 0 命中窗口无界扫描）', () => {
    expect(SCAN_CAP).toBeGreaterThan(0);
    expect(SCAN_CAP).toBeLessThanOrEqual(50_000);
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
  });
});
