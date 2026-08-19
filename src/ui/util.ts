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

export function formatTime(iso: string, mode: 'datetime' | 'relative' | 'iso', t: (k: string, p?: Record<string, string | number>) => string): string {
  if (mode === 'iso') return iso.replace('T', ' ').slice(0, 19);
  if (mode === 'relative') return formatRelative(iso, t);
  return formatDateTime(iso);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let timer: number | undefined;
  return (...a: A) => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(() => { timer = undefined; fn(...a); }, ms);
  };
}
