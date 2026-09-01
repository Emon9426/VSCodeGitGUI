/**
 * explorer.exe 定位辅助（Windows）。
 *
 * ⚠ explorer 对 `/select` 参数的解析**随 Windows 版本漂移**，三轮实测（同机 Win11 26200 +
 * 工作机标准构建）结论如下，新形态必须三环境齐验后再改默认：
 *
 * 1. `explorer /select,C:\path`（单参数 + windowsVerbatimArguments，libuv 不加引号，命令行
 *    原样）——explorer 自解析命令行、取 "/select," 之后整段为路径：**自 XP 起各版本通用的
 *    经典形态**，含空格/中文均可（2026-09-02 本机实测：无空格/含空格/中文+空格全部选中
 *    目标文件）。现为默认（classic）。
 * 2. 分离传参 `['/select,', path]`——2026-09-01 在本机 26200 一切正常，但**工作机（标准
 *    构建）实测无效**（Issue #2 二次反馈）；与本文件 08-28 首轮"分离不被接受"的记录吻合。
 * 3. 带引号 concat（libuv 对含空格参数整体加引号 = Electron shell.showItemInFolder 同形态）
 *    ——标准构建可用，但本机 26200 拒绝解析、退化为打开 Documents（09-01 实测）；VS Code
 *    自带 revealFileInOS 在本机也完全静默无窗口（09-02 实测），同源原因。
 * 4. 目标完整路径 > 259 字符时**所有形态都解析失败**（explorer 固定 MAX_PATH 缓冲，打开
 *    桌面/文档随机）——必须降级到最深 ≤259 祖先目录。
 *
 * 存在性探测：严格实施 MAX_PATH 的系统（LongPathsEnabled=0 的标准 Win10/11，常见于企业
 * 环境）上，Node 对 >259 的真实文件 stat 也会失败（ENOENT）——须用 `\\?\` 扩展前缀重试
 * 才能探到（Win32 扩展路径语义，不依赖系统开关；仅适用于盘符路径）。
 */
import { existsSync } from 'fs';
import { dirname } from 'path';

export const EXPLORER_MAX_PATH = 259;

/** explorer /select 传参形态（见头注释 1-3；gitboard.revealSelectStyle 可切换） */
export type RevealSelectStyle = 'classic' | 'separate' | 'quoted';

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
 * 按形态构造 spawn('explorer', …) 的参数与 verbatim 开关。
 * - classic：单参数 + verbatim（命令行原样 `explorer /select,C:\path with spaces`）
 * - separate：'/select,' 与路径分两个参数（26200 可用，标准构建无效）
 * - quoted：单参数非 verbatim（含空格时 libuv 加引号，标准构建可用，26200 无效）
 */
export function revealSpawnForm(p: string, style: RevealSelectStyle = 'classic'): { args: string[]; verbatim: boolean } {
  if (style === 'separate') return { args: ['/select,', p], verbatim: false };
  if (style === 'quoted') return { args: ['/select,' + p], verbatim: false };
  return { args: ['/select,' + p], verbatim: true };
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
