/**
 * 文件历史页解析器单测（v0.14）：parseFileLog / assignFileEras / chainFromFileLog /
 * dirOldPrefix / detectMove / safeRelPath / isFullSha。
 */
import { describe, expect, it } from 'vitest';
import { FILE_LOG_FORMAT, parseFileLog, assignFileEras, chainFromFileLog, dirOldPrefix, parentDir, detectMove } from '../../src/git/parse';
import { safeRelPath, isFullSha } from '../../src/git/files';
import type { FileEntry } from '../../src/common/models';

const FS = '\x1f';
const RS = '\x1e';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

function head(sha: string, subject: string): string {
  return `${sha}${FS}${sha.slice(0, 7)}${FS}张三${FS}2026-08-29T10:00:00+08:00${FS}${subject}${RS}`;
}

describe('parseFileLog（--follow --name-status 输出）', () => {
  it('pretty 行 + M/A/R 状态行（含中文路径）', () => {
    const out = [
      head(SHA, 'day4 in B/A'),
      '',
      `M\tB/A/需求说明.md`,
      head(SHA2, '重命名：需求草稿 → 需求说明'),
      '',
      `R100\t"A/\\351\\234\\200\\346\\261\\202\\350\\215\\211\\347\\250\\277.md"\t"A/\\351\\234\\200\\346\\261\\202\\350\\257\\264\\346\\230\\216.md"`,
      '',
    ].join('\n');
    const items = parseFileLog(out);
    expect(items).toHaveLength(2);
    expect(items[0].path).toBe('B/A/需求说明.md');
    expect(items[0].status).toBe('M');
    expect(items[0].author).toBe('张三');
    expect(items[1].status).toBe('R');
    expect(items[1].oldPath).toBe('A/需求草稿.md');   // 八进制转义还原
    expect(items[1].path).toBe('A/需求说明.md');
    expect(items[1].milestone).toBe(true);
  });

  it('A 状态（创建）', () => {
    const out = `${head(SHA, '创建')}\n\nA\tA/d1.md\n`;
    const items = parseFileLog(out);
    expect(items[0].status).toBe('A');
    expect(items[0].path).toBe('A/d1.md');
  });

  it('空输出', () => {
    expect(parseFileLog('')).toHaveLength(0);
  });
});

describe('assignFileEras / chainFromFileLog（链切分）', () => {
  it('R 行切分时期：旧时期条目 eraPrefix=当时路径，当前段 undefined；segments 新→旧', () => {
    const items = parseFileLog([
      head('c'.repeat(40), '最新'),
      `M\tB/A/d.md`,
      head(SHA, '移动'),
      `R100\tA/d.md\tB/A/d.md`,
      head(SHA2, '创建'),
      `A\tA/d.md`,
    ].join('\n\n'));
    const changes = assignFileEras(items, 'B/A/d.md');
    expect(changes).toBe(1);
    expect(items[0].eraPrefix).toBeUndefined();          // 当前段
    expect(items[1].eraPrefix).toBeUndefined();          // 移动提交本身（新路径=当前路径）
    expect(items[2].eraPrefix).toBe('A/d.md');           // 旧名时期
    const chain = chainFromFileLog(items, 'B/A/d.md');
    expect(chain.segments).toHaveLength(2);
    expect(chain.segments[0].prefix).toBe('B/A/d.md');
    expect(chain.segments[0].endSha).toBe(SHA);          // 移动提交 = 当前段 endSha
    expect(chain.segments[1].prefix).toBe('A/d.md');
    expect(chain.partial).toBeUndefined();
  });
});

describe('dirOldPrefix（旧前缀投票）', () => {
  it('全覆盖 → 最深公共前缀，非 partial', () => {
    const renames = [
      { oldPath: 'A/f1.md', newPath: 'B/A/f1.md' },
      { oldPath: 'A/f2.md', newPath: 'B/A/f2.md' },
    ];
    const v = dirOldPrefix(renames, 'B/A');
    expect(v.prefix).toBe('A');
    expect(v.partial).toBe(false);
  });

  it('部分拆分（50% < 80%）→ null + partial', () => {
    const renames = [
      { oldPath: 'A/f1.md', newPath: 'B/A/f1.md' },
      { oldPath: 'C/f2.md', newPath: 'B/A/f2.md' },
    ];
    const v = dirOldPrefix(renames, 'B/A');
    expect(v.prefix).toBeNull();
    expect(v.partial).toBe(true);
  });

  it('无匹配条目 → null 非 partial（链终止）', () => {
    const v = dirOldPrefix([{ oldPath: 'x.md', newPath: 'y.md' }], 'B/A');
    expect(v.prefix).toBeNull();
    expect(v.partial).toBe(false);
  });

  it('parentDir', () => {
    expect(parentDir('A/b/c.md')).toBe('A/b');
    expect(parentDir('a.md')).toBe('');
    expect(parentDir('A')).toBe('');
  });
});

describe('detectMove（手动移动检测）', () => {
  const mk = (path: string, o: Partial<FileEntry>): FileEntry =>
    ({ path, staged: null, unstaged: null, untracked: false, ...o } as FileEntry);

  it('同前缀批量 D + 同名未跟踪 → 检出 from/to/paths', () => {
    const entries = [
      mk('A/f1.md', { unstaged: 'D' }),
      mk('A/f2.md', { unstaged: 'D' }),
      mk('B/A/f1.md', { untracked: true }),
      mk('B/A/f2.md', { untracked: true }),
      mk('other.txt', { untracked: true }),
    ];
    const md = detectMove(entries);
    expect(md).toBeDefined();
    expect(md!.from).toBe('A');
    expect(md!.to).toBe('B/A');
    expect(md!.count).toBe(2);
    expect(md!.paths).toHaveLength(4);
  });

  it('无配对（删除与未跟踪不同名）→ undefined', () => {
    const entries = [
      mk('A/old.md', { unstaged: 'D' }),
      mk('B/new.md', { untracked: true }),
    ];
    expect(detectMove(entries)).toBeUndefined();
  });
});

describe('safeRelPath / isFullSha（入参白名单）', () => {
  it('常规中文/空格/点路径通过，反斜杠归一，# & % 等常见符号通过', () => {
    expect(safeRelPath('B/A/需求说明.md')).toBe('B/A/需求说明.md');
    expect(safeRelPath('a b/c d.txt')).toBe('a b/c d.txt');
    expect(safeRelPath('src\\lib\\x.ts')).toBe('src/lib/x.ts');
    expect(safeRelPath('井号#文件.txt')).toBe('井号#文件.txt');
    expect(safeRelPath('和&与+.log')).toBe('和&与+.log');
    expect(safeRelPath('百分%比^等={值}.md')).toBe('百分%比^等={值}.md');
  });
  it('拒绝选项/魔法前缀与 glob 元字符', () => {
    expect(safeRelPath('--inject')).toBeNull();
    expect(safeRelPath(':(literal)x')).toBeNull();
    expect(safeRelPath('A[x]/f.md')).toBeNull();
    expect(safeRelPath('')).toBeNull();
    expect(safeRelPath('x**')).toBeNull();
  });
  it('拒绝路径穿越（安全审查修复）', () => {
    expect(safeRelPath('../outside.txt')).toBeNull();
    expect(safeRelPath('a/../../etc/passwd')).toBeNull();
    expect(safeRelPath('a/../b/c.md')).toBeNull();   // 含 .. 段一律拒绝（保守策略）
    expect(safeRelPath('..')).toBeNull();
    expect(safeRelPath('a/./b.md')).toBe('a/./b.md'); // 单点段不拦（git 规范化处理）
  });
  it('isFullSha', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true);
    expect(isFullSha('abc')).toBe(false);
    expect(isFullSha('Z'.repeat(40))).toBe(false);
  });
});

describe('FILE_LOG_FORMAT', () => {
  it('格式常量含字段分隔', () => {
    expect(FILE_LOG_FORMAT).toContain(FS);
    expect(FILE_LOG_FORMAT.endsWith(RS)).toBe(true);
  });
});
