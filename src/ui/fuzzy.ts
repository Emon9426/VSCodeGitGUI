/**
 * 子序列模糊匹配（Issue #24）：大小写不敏感；连续命中与词首（开头或 - _ . / 之后）加分。
 * positions = 命中字符下标（供高亮）；query 为空时全体命中（score 0）。
 */
export interface FuzzyResult {
  score: number;
  positions: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prevHit = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) { found = i; break; }
    }
    if (found === -1) return null;   // 子序列断裂
    positions.push(found);
    score += 1;
    if (found === prevHit + 1) score += 2;   // 连续命中
    const prevChar = found > 0 ? t[found - 1] : '';
    if (found === 0 || prevChar === '/' || prevChar === '-' || prevChar === '_' || prevChar === '.') score += 2;   // 词首
    prevHit = found;
    ti = found + 1;
  }
  return { score, positions };
}
