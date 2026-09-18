import { describe, expect, it } from 'vitest';
import { gitErrorHint, pushNeedsPull, PUSH_NEEDS_PULL_RE } from '../../src/ui/app/pushTriage';

/** GitHub 大文件拒绝的真实输出形态（pre-receive hook declined，stderr 尾部） */
const GH_LARGE_FILE = [
  "remote: error: GH001: Large files detected. See https://gh.io/lfs for more information.",
  "remote: error: File big.zip is 250.31 MB; this exceeds GitHub's file size limit of 100.00 MB",
  "remote: error: File data.bin is 180.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
  "To github.com:user/repo.git",
  " ! [remote rejected] main -> main (pre-receive hook declined)",
  "error: failed to push some refs to 'github.com:user/repo.git'",
].join('\n');

/** 受保护分支拒绝（同为 remote rejected，非本地落后） */
const PROTECTED_BRANCH = [
  "remote: error: GH006: Protected branch update failed for refs/heads/main.",
  "remote: error: Cannot force-push to this protected branch",
  'To github.com:user/repo.git',
  " ! [remote rejected] main -> main (protected branch hook declined)",
  "error: failed to push some refs to 'github.com:user/repo.git'",
].join('\n');

/** 真正的远端领先：客户端 fetch first 拒绝 */
const FETCH_FIRST = [
  'To github.com:user/repo.git',
  ' ! [rejected]        main -> main (fetch first)',
  "error: failed to push some refs to 'github.com:user/repo.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
  'hint: its remote counterpart. Integrate the remote changes (e.g.',
].join('\n');

/** --force-with-lease 失效：stale info + behind hint */
const STALE_INFO = [
  'To github.com:user/repo.git',
  ' ! [rejected]        main -> main (stale info)',
  "error: failed to push some refs to 'github.com:user/repo.git'",
  'hint: Updates were rejected because the tip of your current branch is behind',
].join('\n');

describe('pushNeedsPull：仅远端领先/非快进才建议拉取', () => {
  it('大文件拒绝（GH001 + pre-receive declined）不误报为 non-fast-forward', () => {
    expect(pushNeedsPull(GH_LARGE_FILE)).toBe(false);
  });

  it('受保护分支拒绝（GH006）不误报', () => {
    expect(pushNeedsPull(PROTECTED_BRANCH)).toBe(false);
  });

  it('客户端 fetch first 拒绝命中（拉取合并对症）', () => {
    expect(pushNeedsPull(FETCH_FIRST)).toBe(true);
  });

  it('non-fast-forward 拒绝命中', () => {
    expect(pushNeedsPull(' ! [rejected]  main -> main (non-fast-forward)')).toBe(true);
  });

  it('--force-with-lease 失效（stale info + branch is behind hint）命中', () => {
    expect(pushNeedsPull(STALE_INFO)).toBe(true);
  });

  it('服务端 hook 文案自带 non-fast-forward 字样不误报（remote: 行剔除后再判定）', () => {
    const out = [
      'remote: error: refusing non-fast-forward push per policy',
      " ! [remote rejected] main -> main (pre-receive hook declined)",
    ].join('\n');
    expect(pushNeedsPull(out)).toBe(false);
  });

  it('裸正则常量保持导出（供回归锚定）', () => {
    expect(PUSH_NEEDS_PULL_RE.test('(non-fast-forward)')).toBe(true);
    expect(PUSH_NEEDS_PULL_RE.test('(fetch first)')).toBe(true);
  });
});

describe('gitErrorHint：从输出尾部提取真实错误行', () => {
  it('大文件场景提取 remote: error 行（去前缀，含 GH001 与文件明细）', () => {
    const hint = gitErrorHint(GH_LARGE_FILE)!;
    expect(hint).toContain("GH001: Large files detected");
    expect(hint).toContain("big.zip is 250.31 MB");
    expect(hint).not.toContain('remote:');
    expect(hint).not.toContain('failed to push');   // 收尾行不进正文（折叠详情已有）
  });

  it('服务端错误多于 3 条时只取前 3（正文紧凑，全量在详情）', () => {
    const out = [
      'remote: error: GH001: Large files detected.',
      'remote: error: File a.bin is 120.00 MB; too big',
      'remote: error: File b.bin is 130.00 MB; too big',
      'remote: error: File c.bin is 140.00 MB; too big',
      'remote: error: File d.bin is 150.00 MB; too big',
      " ! [remote rejected] main -> main (pre-receive hook declined)",
    ].join('\n');
    expect(gitErrorHint(out)!.split('\n')).toHaveLength(3);
  });

  it('本地/认证错误取末尾 error:/fatal: 行', () => {
    expect(gitErrorHint("fatal: Authentication failed for 'https://github.com/user/repo.git/'"))
      .toBe("Authentication failed for 'https://github.com/user/repo.git/'");
    expect(gitErrorHint("error: failed to push some refs to 'x'"))
      .toBe("failed to push some refs to 'x'");
  });

  it('无错误行（进度/停滞文案）返回 undefined（调用方落回泛化 message）', () => {
    expect(gitErrorHint('network stalled: no-output watchdog fired')).toBeUndefined();
    expect(gitErrorHint('')).toBeUndefined();
  });

  it('remote: warning 行不进入正文（仅 error 级才是拒绝原因）', () => {
    const out = [
      "remote: warning: File mid.zip is 60.00 MB; this is larger than GitHub's recommendation",
      "remote: error: File huge.zip is 200.00 MB; this exceeds GitHub's file size limit",
      " ! [remote rejected] main -> main (pre-receive hook declined)",
    ].join('\n');
    expect(gitErrorHint(out)).not.toContain('warning');
    expect(gitErrorHint(out)).toContain('huge.zip');
  });
});
