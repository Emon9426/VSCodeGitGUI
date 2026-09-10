/**
 * 分支前缀分组（Issue #24 / #23）：按 display 名首段 "/" 前缀分组（feature/x → 组 feature），
 * 无前缀或尾斜杠留顶层；组间按前缀字母序，组内顺序保持传入序（调用方已按名排序）。
 * 恒分组（决议 D3：不设阈值）；配置 branchGroupByPrefix=false 时调用方走平铺。
 */
export interface PrefixGroup<T> {
  prefix: string;
  items: T[];
}

export function groupByPrefix<T>(items: T[], nameOf: (t: T) => string): { top: T[]; groups: PrefixGroup<T>[] } {
  const top: T[] = [];
  const map = new Map<string, T[]>();
  for (const it of items) {
    const name = nameOf(it);
    const i = name.indexOf('/');
    if (i <= 0 || i === name.length - 1) {
      top.push(it);
      continue;
    }
    const prefix = name.slice(0, i);
    const list = map.get(prefix);
    if (list) list.push(it); else map.set(prefix, [it]);
  }
  const groups = [...map.entries()]
    .map(([prefix, list]) => ({ prefix, items: list }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
  return { top, groups };
}
