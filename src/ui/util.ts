/** DOM/格式化小工具。所有 git 来源文本一律走 textContent，杜绝 XSS。 */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 设计方案 4.4：默认 YYYY-MM-DD HH:mm:ss（24 小时制，跟随本地时区） */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatRelative(iso: string, t: (k: string, p?: Record<string, string | number>) => string): string {
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return iso;
  const diff = Date.now() - d;
  const min = Math.round(diff / 60_000);
  if (min < 1) return t('justNow');
  if (min < 60) return t('minAgo', { n: min });
  const hour = Math.round(min / 60);
  if (hour < 24) return t('hourAgo', { n: hour });
  const day = Math.round(hour / 24);
  if (day < 7) return t('dayAgo', { n: day });
  const week = Math.round(day / 7);
  if (week < 52) return t('weekAgo', { n: week });
  return t('relativeOld', { n: Math.round(week / 52) });
}

/** 紧凑格式（Issue #18 S1）：提交列表时间列在极窄窗下降级为 MM-DD HH:mm，完整值保留在 title */
export function formatCompact(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTime(iso: string, mode: 'datetime' | 'relative' | 'iso' | 'compact', t: (k: string, p?: Record<string, string | number>) => string): string {
  if (mode === 'iso') return iso.replace('T', ' ').slice(0, 19);
  if (mode === 'relative') return formatRelative(iso, t);
  if (mode === 'compact') return formatCompact(iso);
  return formatDateTime(iso);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: number | undefined;
  return (...a: A) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => { timer = undefined; fn(...a); }, ms);
  };
}

// ---------- 路径分组（#46 收敛：workView / detailPanel / pullSummary 三处同构逻辑） ----------

/** 文件基名（'a/b/c.txt' → 'c.txt'；无斜杠原样） */
export function baseOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

/** 目录部分（'a/b/c.txt' → 'a/b'；根目录 ''）——不含尾斜杠 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : '';
}

export interface PathGroup<T> {
  /** 目录（根目录为 ''；不含尾斜杠，排序/逻辑用） */
  dir: string;
  /** 组头显示文本：根目录显仓库绝对路径（rootLabel），其余为 '目录/'（带尾斜杠，v0.12 起的既有视觉） */
  head: string;
  /** 组内项（保持传入序，组内排序归调用方） */
  items: T[];
}

/**
 * 按目录分组：目录字母序、根目录置顶（三处调用点统一的 #22/#35 语义）。
 * 组内不排序——调用方按各自需求处理（workView 传前预排序，pullSummary 按新路径排序）。
 */
export function groupPaths<T>(items: T[], pathOf: (t: T) => string, rootLabel?: string): PathGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const d = dirOf(pathOf(it));
    const list = groups.get(d);
    if (list) list.push(it); else groups.set(d, [it]);
  }
  const root = rootLabel ?? '/';
  return [...groups.keys()]
    .sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(d => ({ dir: d, head: d === '' ? root : d + '/', items: groups.get(d)! }));
}
