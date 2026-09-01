/**
 * explorer.exe 长路径定位辅助（Windows）。
 *
 * explorer 命令行解析层使用固定 MAX_PATH 缓冲，实测两轮（相隔数日、同机 Win11 26200）结论
 * 曾发生反转——系统更新会改变其行为，以下为 2026-09-01 最新矩阵（spawn 直调 + Shell COM
 * 探针观测窗口位置与选中项，e2e 双场景复核）：
 *
 * - `/select,<路径>` concat 形态：路径**含空格**时 libuv 必然给整个参数加引号，explorer
 *   不接受带引号的 `"/select,路径"` 单 token → 解析失败退化为打开默认位置（Documents）；
 *   无空格且 ≤259 时正常（2026-08-28 实测"含空格也稳定"已被推翻）。
 * - `/select` 与路径**分离传参**（两个参数）：≤259 的文件/目录、含空格、中文、windowsHide
 *   全部正常选中（2026-08-28 实测"分离不被接受"同样已被推翻）。
 * - 目标完整路径 > 259 字符时两种形态都解析失败（打开桌面/文档随机）。
 *
 * 降级策略：上溯到最长 ≤ 259 的祖先目录并选中它——资源管理器离目标最近的
 * 可定位位置（用户从高亮的目录继续点入即可）。
 *
 * 存在性探测：严格实施 MAX_PATH 的系统（LongPathsEnabled=0 的标准 Win10/11，常见于
 * 企业环境）上，Node 对 >259 的真实文件 stat 也会失败（ENOENT）——须用 `\\?\` 扩展
 * 前缀重试才能探到（Win32 扩展路径语义，不依赖系统开关；仅适用于盘符路径）。
 */
import { existsSync } from 'fs';
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

/**
 * 文件存在性探测：普通 stat 失败且为超长盘符路径时，用 `\\?\` 扩展前缀重试。
 * 防严格 MAX_PATH 系统上"文件明明存在却被判不存在"的误报（Issue #1 的误报分支）。
 */
export function fsExistsRobust(p: string): boolean {
  if (existsSync(p)) return true;
  // \\?\ 只对盘符绝对路径合法；UNC 需要 \\?\UNC\ 形态，此处不扩展（探测失败=维持原判定，无回归）
  return p.length > EXPLORER_MAX_PATH && /^[A-Za-z]:\\/.test(p) && existsSync('\\\\?\\' + p);
}
