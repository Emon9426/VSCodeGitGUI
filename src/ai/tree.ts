/**
 * AI 提交信息的路径级上下文（v0.13）：
 * 暂存差异过大/超时无法取内容时，降级为"文件名 + 目录结构"推断改动意图。
 * 纯函数，单测对象。
 */

/** 路径级变更条目（status：M/A/D/R/C…；untracked 归一为 A） */
export interface TreeEntry {
  status: string;
  path: string;
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: { name: string; status: string }[];
  count: number;   // 子树文件总数
}

const TREE_MAX_LINES = 400;

/**
 * 变更文件目录树（供 AI 推断改动范围）：
 * 目录按字母序在前、文件在后，目录标注子树文件数，文件标注状态字母；超 400 行聚合截断。
 */
export function buildFileTree(entries: TreeEntry[]): string {
  if (!entries.length) return '';
  const root: TreeNode = { dirs: new Map(), files: [], count: 0 };
  for (const e of entries) {
    const parts = e.path.split('/');
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      let child = node.dirs.get(seg);
      if (!child) { child = { dirs: new Map(), files: [], count: 0 }; node.dirs.set(seg, child); }
      child.count++;
      node = child;
    }
    node.files.push({ name: parts[parts.length - 1], status: e.status });
  }
  const lines: string[] = [];
  let cut = false;
  const push = (line: string): boolean => {
    if (lines.length >= TREE_MAX_LINES) { cut = true; return false; }
    lines.push(line);
    return true;
  };
  const walk = (node: TreeNode, depth: number): void => {
    if (cut) return;
    const pad = '  '.repeat(depth);
    for (const [name, child] of [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (!push(`${pad}${name}/ (${child.count})`)) return;
      walk(child, depth + 1);
      if (cut) return;
    }
    for (const f of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!push(`${pad}${f.name} (${f.status})`)) return;
    }
  };
  walk(root, 0);
  // 已列文件行（以状态字母结尾；目录行以数字计数结尾不会误匹配）
  const listed = lines.filter(l => /\([A-Z]\)$/.test(l)).length;
  const rest = entries.length - listed;
  if (rest > 0) lines.push(`…(另有 ${rest} 个文件未列出)`);
  return lines.join('\n');
}

/** 变更清单（fallback 时的 summary 替身）：" M\tpath" 每行，走 clampSummary 同款封顶 */
export function formatEntryList(entries: TreeEntry[]): string {
  return entries.map(e => ` ${e.status}\t${e.path}`).join('\n');
}

/** truncateCachedDiff 的省略标记行（这些行不构成可推断的内容） */
const OMIT_RE = /内容已省略|已截断|其余已暂存|差异已省略/;

/**
 * diff 内容可用性：文件少（≤4）时截断残片仍有意义；文件多时若去掉省略标记后
 * 有效内容不足 400 字符，视为"内容不可用"——交由路径级上下文接管。
 */
export function diffContentUsable(diffText: string, fileCount: number): boolean {
  if (fileCount <= 4) return true;
  const t = (diffText ?? '').trim();
  if (!t) return false;
  const useful = t.split('\n').filter(l => l && !OMIT_RE.test(l)).join('\n');
  return useful.length >= 400;
}
