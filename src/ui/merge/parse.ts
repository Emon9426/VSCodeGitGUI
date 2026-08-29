/**
 * 冲突标记解析（设计方案 v1.3 §5.3）：
 * 把含 git 冲突标记的工作副本内容解析为「公共段 + 冲突块」序列。
 * git 标记只在解析/序列化时出现，三栏 UI 永不显示。
 *
 * 进度落盘约定：serialize 时已解决的块写为普通行；未解决的块按原始标记重建
 * ——部分解决也随时可写回文件，重开会话进度无损。
 */

export interface ConflictChunk {
  index: number;               // 块序号（0 起，按出现顺序）
  mineLines: string[];         // 我的段（不含标记行）
  theirsLines: string[];       // 他人段
  baseLines: string[] | null;  // diff3（|||||||）时的 base 段
  mineLabel: string;           // '<<<<<<< ' 后的标签（如 HEAD）
  theirsLabel: string;         // '>>>>>>> ' 后的标签（如 origin/x）
}

export type Seg =
  | { type: 'common'; lines: string[] }
  | { type: 'conflict'; chunk: ConflictChunk };

export interface ParsedMerge {
  eol: '\n' | '\r\n';
  bom: boolean;
  segs: Seg[];
  chunks: ConflictChunk[];
  hasMarkers: boolean;
}

const RE_START = /^<{7}(?!<) ?(.*)$/;
const RE_BASE = /^\|{7}(?!\|)/;
const RE_SEP = /^={7}$/;
const RE_END = /^>{7}(?!>) ?(.*)$/;

/** 解析工作副本内容（含冲突标记）；无标记时 hasMarkers=false、整文为一个公共段 */
export function parseMergeResult(text: string): ParsedMerge {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  // 行尾：CRLF 占优则统一 CRLF（内部行剥离 \r，序列化时统一恢复）
  const crlf = (body.match(/\r\n/g) ?? []).length > (body.match(/(?<!\r)\n/g) ?? []).length;
  const eol: '\n' | '\r\n' = crlf ? '\r\n' : '\n';
  const rawLines = body.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));

  const segs: Seg[] = [];
  const chunks: ConflictChunk[] = [];
  let common: string[] = [];
  let hasMarkers = false;

  // 块内状态机：mine → (base) → sep → theirs → end
  let mine: string[] | null = null;
  let base: string[] | null = null;
  let theirs: string[] | null = null;
  let mineLabel = '';
  let theirsLabel = '';

  const flushCommon = () => {
    if (common.length) { segs.push({ type: 'common', lines: common }); common = []; }
  };
  const flushChunk = () => {
    if (!mine) return;
    flushCommon();
    const chunk: ConflictChunk = {
      index: chunks.length, mineLines: mine, theirsLines: theirs ?? [],
      baseLines: base, mineLabel, theirsLabel,
    };
    chunks.push(chunk);
    segs.push({ type: 'conflict', chunk });
    mine = null; base = null; theirs = null; mineLabel = ''; theirsLabel = '';
  };

  for (const line of rawLines) {
    if (mine === null) {
      const m = line.match(RE_START);
      if (m) {
        hasMarkers = true;
        mine = [];
        base = null; theirs = null;
        mineLabel = m[1] ?? '';
        theirsLabel = '';
        continue;
      }
      common.push(line);
      continue;
    }
    // 块内
    if (theirs === null) {
      if (RE_SEP.test(line)) { theirs = []; continue; }
      if (base === null) {
        if (RE_BASE.test(line)) { base = []; continue; }
        mine.push(line);
      } else {
        base.push(line);
      }
      continue;
    }
    const e = line.match(RE_END);
    if (e) {
      theirsLabel = e[1] ?? '';
      flushChunk();
      continue;
    }
    theirs.push(line);
  }
  // 截断容错：标记未闭合（文件被外部截断）→ 残余行并入 mine 段，按未完成块保留
  if (mine !== null) flushChunk();
  if (common.length) segs.push({ type: 'common', lines: common });
  return { eol, bom, segs, chunks, hasMarkers };
}

/**
 * 序列化：公共段按序 + 各块结果。
 * chunkResults 缺失的块按原始标记重建（含 mine/theirs 段与标签），
 * 保证部分解决的进度也能安全写回。
 */
export function serializeMergeResult(parsed: ParsedMerge, chunkResults: Map<number, string[]>): string {
  const out: string[] = [];
  for (const seg of parsed.segs) {
    if (seg.type === 'common') { out.push(...seg.lines); continue; }
    const c = seg.chunk;
    const resolved = chunkResults.get(c.index);
    if (resolved) { out.push(...resolved); continue; }
    out.push('<<<<<<< ' + (c.mineLabel || 'HEAD'));
    out.push(...c.mineLines);
    if (c.baseLines) { out.push('||||||| base'); out.push(...c.baseLines); }
    out.push('=======');
    out.push(...c.theirsLines);
    out.push('>>>>>>> ' + (c.theirsLabel || 'theirs'));
  }
  const body = out.join(parsed.eol);
  return (parsed.bom ? '\uFEFF' : '') + body;
}

/** 总展示行数（公共 + 块结果行；用于 minimap 定位） */
export function totalLinesOf(parsed: ParsedMerge, chunkResults: Map<number, string[]>): number {
  let n = 0;
  for (const seg of parsed.segs) {
    if (seg.type === 'common') n += seg.lines.length;
    else n += (chunkResults.get(seg.chunk.index) ?? seg.chunk.mineLines).length;
  }
  return n;
}
