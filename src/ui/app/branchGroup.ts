/**
 * 分支前缀分组（Issue #24 / #23；v0.23.2 递归多级）：按 display 名的 "/" 前缀逐段建树
 * （release/1.0/x → 组 release > 子组 1.0），无前缀或含空段（前导/尾随/连续斜杠）留顶层；
 * 组间按段字母序，组内顺序保持传入序（调用方已按名排序）。
 * 恒分组（决议 D3：不设阈值）；配置 branchGroupByPrefix=false 时调用方走平铺。
 */
export interface PrefixNode<T> {
  /** 本段前缀（不含斜杠）；根为 '' */
  seg: string;
  /** 完整前缀路径（'release/1.0'，自一级前缀起算）；根为 '' */
  path: string;
  /** 名字恰好终结在本层的项 */
  items: T[];
  /** 子前缀组（按段字母序） */
  children: PrefixNode<T>[];
}

export function buildPrefixTree<T>(items: T[], nameOf: (t: T) => string): { top: T[]; root: PrefixNode<T> } {
  const top: T[] = [];
  const root: PrefixNode<T> = { seg: '', path: '', items: [], children: [] };
  for (const it of items) {
    const segs = nameOf(it).split('/');
    if (segs.length === 1 || segs.some(s => !s)) { top.push(it); continue; }
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      let ch = node.children.find(c => c.seg === seg);
      if (!ch) {
        ch = { seg, path: node.path ? `${node.path}/${seg}` : seg, items: [], children: [] };
        node.children.push(ch);
      }
      node = ch;
    }
    node.items.push(it);
  }
  const sortKids = (n: PrefixNode<T>): void => {
    n.children.sort((a, b) => a.seg.localeCompare(b.seg));
    n.children.forEach(sortKids);
  };
  sortKids(root);
  return { top, root };
}

/** 组内项数（递归含全部子组），用于组头计数 */
export function countNode<T>(n: PrefixNode<T>): number {
  return n.items.length + n.children.reduce((s, c) => s + countNode(c), 0);
}

/** 组内项的显示短名：剥去组前缀与分隔斜杠（根组原样返回） */
export function stripTo(path: string, name: string): string {
  return path && name.startsWith(path + '/') ? name.slice(path.length + 1) : name;
}
