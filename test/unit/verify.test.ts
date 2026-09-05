/**
 * OpVerifier 判定矩阵单测（Issue #6 后续：意图-探针-判定的纯判定层）。
 * 探针层（真实 git 调用）由 test/integration/opVerify.git.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest';
import { judgeByTrack, judgeHeadChanged, judgeHeadEquals, judgeTag, parseTrack } from '../../src/ops/verify';

describe('parseTrack（for-each-ref track 输出解析）', () => {
  it('ahead/behind 混合', () => {
    expect(parseTrack('ahead 2, behind 1')).toEqual({ ahead: 2, behind: 1 });
  });
  it('单边与空串', () => {
    expect(parseTrack('ahead 3')).toEqual({ ahead: 3, behind: 0 });
    expect(parseTrack('behind 5')).toEqual({ ahead: 0, behind: 5 });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 });
  });
});

describe('judgeByTrack（pull/push 意图判定）', () => {
  it('pull：behind>0 = warn（拉取未完全合并）', () => {
    const r = judgeByTrack('pull', { ahead: 0, behind: 3 });
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('behind');
    expect(r.n).toBe(3);
  });
  it('pull：仅 ahead（本地领先）= pass', () => {
    expect(judgeByTrack('pull', { ahead: 2, behind: 0 }).verdict).toBe('pass');
  });
  it('push：ahead>0 = warn（有提交未到达上游）', () => {
    const r = judgeByTrack('push', { ahead: 4, behind: 0 });
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('ahead');
    expect(r.n).toBe(4);
  });
  it('push：仅 behind（落后未拉）= pass（推送本身到位）', () => {
    expect(judgeByTrack('push', { ahead: 0, behind: 2 }).verdict).toBe('pass');
  });
  it('全同步 = pass', () => {
    expect(judgeByTrack('pull', { ahead: 0, behind: 0 }).verdict).toBe('pass');
    expect(judgeByTrack('push', { ahead: 0, behind: 0 }).verdict).toBe('pass');
  });
});

describe('judgeHeadChanged（commit 意图判定）', () => {
  it('HEAD 前进 = pass；未变化 = warn', () => {
    expect(judgeHeadChanged('a'.repeat(40), 'b'.repeat(40)).verdict).toBe('pass');
    const r = judgeHeadChanged('a'.repeat(40), 'a'.repeat(40));
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('headUnchanged');
  });
  it('无基准 = unknown（fail-open）', () => {
    expect(judgeHeadChanged(undefined, 'a'.repeat(40)).verdict).toBe('unknown');
  });
});

describe('judgeHeadEquals（checkout/reset 意图判定）', () => {
  it('匹配 = pass；不匹配 = warn(headMismatch)；无预期 = unknown', () => {
    expect(judgeHeadEquals('a'.repeat(40), 'a'.repeat(40)).verdict).toBe('pass');
    const r = judgeHeadEquals('a'.repeat(40), 'b'.repeat(40));
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('headMismatch');
    expect(judgeHeadEquals(undefined, 'a'.repeat(40)).verdict).toBe('unknown');
  });
});

describe('judgeTag（标签存在性判定）', () => {
  it('tagCreate：存在 = pass，缺失 = warn(tagMissing)', () => {
    expect(judgeTag(true, true).verdict).toBe('pass');
    const r = judgeTag(true, false);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('tagMissing');
  });
  it('tagDelete：消失 = pass，仍存在 = warn(tagExists)', () => {
    expect(judgeTag(false, false).verdict).toBe('pass');
    const r = judgeTag(false, true);
    expect(r.verdict).toBe('warn');
    expect(r.reason).toBe('tagExists');
  });
});
