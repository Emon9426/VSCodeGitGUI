/**
 * Issue #7 合并会话分类单测（classifyMergeSession 纯函数）：
 * 文本 / 二进制（PNG/xlsx/docx 类 NUL 内容）/ 万行长文本（超限阈值）/ 删除侧 XY 码与 rebase 反转。
 */
import { describe, expect, it } from 'vitest';
import { classifyMergeSession } from '../../src/git/parse';

/** 真实 PNG 头（89 50 4E 47 0D 0A 1A 0A + IHDR 长度字段含 NUL）——二进制判定的现实形态 */
function pngBytes(payload: string): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  return Buffer.concat([header, Buffer.from(payload, 'latin1'), Buffer.from([0x00, 0x00, 0x00, 0x00])]);
}

/** xlsx/docx 均为 ZIP 容器：PK\x03\x04 头 + 版本字段 NUL */
function zipBytes(payload: string): Buffer {
  const header = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]);
  return Buffer.concat([header, Buffer.from(payload, 'latin1')]);
}

function lines(n: number, marker = ''): string {
  const parts: string[] = [];
  for (let i = 1; i <= n; i++) parts.push(`line ${i}${marker}`);
  return parts.join('\n');
}

describe('classifyMergeSession（Issue #7）', () => {
  it('纯文本 UU：非二进制非超限，无删除侧', () => {
    const c = classifyMergeSession('merge', 'UU', 'a\nb\n', 'a\nc\n');
    expect(c.binary).toBe(false);
    expect(c.tooLarge).toBe(false);
    expect(c.mineGone).toBe(false);
    expect(c.theirsGone).toBe(false);
    expect(c.deletedSideText).toBeUndefined();
    expect(c.deletedSideBinary).toBeUndefined();
    expect(c.lines).toBe(3);
  });

  it('图片（PNG 头含 NUL）→ 二进制会话', () => {
    const c = classifyMergeSession('merge', 'UU', pngBytes('mine-img').toString('latin1'), pngBytes('theirs-img').toString('latin1'));
    expect(c.binary).toBe(true);
    expect(c.tooLarge).toBe(false);
  });

  it('Excel/Word（ZIP 容器 PK 头）→ 二进制会话', () => {
    const c = classifyMergeSession('merge', 'UU', zipBytes('sheet1-ours').toString('latin1'), zipBytes('sheet1-theirs').toString('latin1'));
    expect(c.binary).toBe(true);
  });

  it('万行代码（10000 行）不超限；超 16000 行 → 超限会话', () => {
    const wan = classifyMergeSession('merge', 'UU', lines(10000), lines(10000, '-t'));
    expect(wan.tooLarge).toBe(false);
    expect(wan.lines).toBe(10000);
    const over = classifyMergeSession('merge', 'UU', lines(20001), lines(5));
    expect(over.tooLarge).toBe(true);
    expect(over.lines).toBe(20001);
  });

  it('单侧超 2MB → 超限（字节维度）', () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const c = classifyMergeSession('merge', 'UU', big, 'small');
    expect(c.tooLarge).toBe(true);
  });

  it('超限优先于二进制：超大二进制按超限处理（两标志同真，使用方先判 tooLarge）', () => {
    const hugeBin = pngBytes('y'.repeat(2 * 1024 * 1024)).toString('latin1');
    const c = classifyMergeSession('merge', 'UU', hugeBin, 's');
    expect(c.tooLarge).toBe(true);
    expect(c.binary).toBe(true);
  });

  it('删除侧（merge 语义）：DU=我删、UD=对方删、DD=双删', () => {
    expect(classifyMergeSession('merge', 'DU', '', 'kept').mineGone).toBe(true);
    expect(classifyMergeSession('merge', 'DU', '', 'kept').deletedSideText).toBe('mine');
    expect(classifyMergeSession('merge', 'UD', 'kept', '').deletedSideText).toBe('theirs');
    const dd = classifyMergeSession('merge', 'DD', '', '');
    expect(dd.mineGone).toBe(true);
    expect(dd.theirsGone).toBe(true);
    expect(dd.deletedSideText).toBeUndefined();   // 双删：文本会话只剩采纳删除
    expect(dd.deletedSideBinary).toBe('theirs');  // 二进制会话 DD 的既有约定
  });

  it('删除侧（rebase 反转）：UD 在 rebase 下=我方不存在', () => {
    const c = classifyMergeSession('rebase', 'UD', '', 'replayed');
    expect(c.mineGone).toBe(true);
    expect(c.deletedSideText).toBe('mine');
  });

  it('gone 侧不参与 NUL 判定：一方删除 + 对方文本 → 非二进制', () => {
    const c = classifyMergeSession('merge', 'DU', '', 'plain text\n');
    expect(c.binary).toBe(false);
    expect(c.deletedSideText).toBe('mine');
  });
});
