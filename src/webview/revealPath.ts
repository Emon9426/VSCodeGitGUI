/**
 * explorer.exe 长路径定位辅助（Windows）。
 *
 * 窗口级实测（2026-08-28，Win11 26200 / node22 spawn 直调）：explorer 命令行解析层
 * 使用固定 MAX_PATH 缓冲——目标完整路径 > 259 字符时 `/select,<路径>` 与直接打开
 * 目录两种形态均解析失败，explorer 退化为打开默认位置（桌面/文档，每次随机）；
 * `\\?\` 前缀、/select 与路径分离传参同样不被接受。而 ≤ 259 字符时一切正常
 * （实测边界：259 成功、260 失败，恰为 MAX_PATH=260 含 NUL 终止符）。
 *
 * 降级策略：上溯到最长 ≤ 259 的祖先目录并选中它——资源管理器离目标最近的
 * 可定位位置（用户从高亮的目录继续点入即可）。
 */
import { dirname } from 'path';

export const EXPLORER_MAX_PATH = 259;

/**
 * 返回可交给 `explorer /select` 的路径：原路径 ≤ 上限时原样返回；
 * 超限时返回最长 ≤ 上限的祖先目录；连盘根都无法满足时返回 undefined（理论不可达，防御）。
 */
export function revealableAncestor(p: string, maxLen: number = EXPLORER_MAX_PATH): string | undefined {
  if (p.length <= maxLen) return p;
  let d = p;
  while (d.length > maxLen) {
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
  return d;
}
