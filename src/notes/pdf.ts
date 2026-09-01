/**
 * HTML → PDF 静默转换（v0.15.0）：探测本机 Edge/Chrome → headless --print-to-pdf。
 * 已知坑（Chromium 128+）：不指定独立 --user-data-dir 时静默失效（复用现有实例），
 * 因此每次转换使用一次性临时 profile；产物校验存在且 >0 字节；失败返回 undefined 由调用方回退
 * 「浏览器打开 HTML 手动打印」。spawn 程序名一律字面量路径（静态过审形态），参数走数组、无 shell。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 各平台浏览器候选路径（顺序即优先级；均为安装期固定路径，不做运行时拼接） */
function existsFile(exe: string): boolean {
  try { fs.accessSync(exe, fs.constants.X_OK); return true; } catch { return false; }
}

type BrowserKey = 'edge86' | 'edge' | 'chrome86' | 'chrome' | 'macEdge' | 'macChrome' | 'macChromium'
  | 'linuxMsedge' | 'linuxChromium' | 'linuxChromiumBrowser' | 'linuxChrome' | 'linuxOptChrome';

function findBrowser(): BrowserKey | undefined {
  if (process.platform === 'win32') {
    if (existsFile('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')) return 'edge86';
    if (existsFile('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe')) return 'edge';
    if (existsFile('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) return 'chrome';
    if (existsFile('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe')) return 'chrome86';
    return undefined;
  }
  if (process.platform === 'darwin') {
    if (existsFile('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')) return 'macEdge';
    if (existsFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) return 'macChrome';
    if (existsFile('/Applications/Chromium.app/Contents/MacOS/Chromium')) return 'macChromium';
    return undefined;
  }
  if (existsFile('/usr/bin/msedge')) return 'linuxMsedge';
  if (existsFile('/usr/bin/chromium')) return 'linuxChromium';
  if (existsFile('/usr/bin/chromium-browser')) return 'linuxChromiumBrowser';
  if (existsFile('/usr/bin/google-chrome')) return 'linuxChrome';
  if (existsFile('/opt/google/chrome/chrome')) return 'linuxOptChrome';
  return undefined;
}

export type PdfResult = { ok: true; pdfPath: string } | { ok: false; reason: 'noBrowser' | 'convertFailed' };

/** 等待进程退出后校验产物（print-to-pdf 落盘与 exit 可能竞态，短暂等待） */
function waitForExit(child: ReturnType<typeof spawn>, timer: NodeJS.Timeout, verify: () => boolean): Promise<boolean> {
  return new Promise(resolve => {
    child.on('exit', () => {
      clearTimeout(timer);
      setTimeout(() => resolve(verify()), 250);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * 将 htmlFile（已落盘）转换为 pdfPath。失败不抛异常，返回 ok:false 由调用方回退手动打印。
 */
export async function htmlToPdf(htmlFile: string, pdfPath: string, timeoutMs = 60000): Promise<PdfResult> {
  const key = findBrowser();
  if (!key) return { ok: false, reason: 'noBrowser' };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-pdf-'));
  const fileUrl = 'file:///' + htmlFile.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  const args = [
    '--headless', '--disable-gpu', '--no-first-run', '--disable-extensions',
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${pdfPath}`,
    fileUrl,
  ];
  // 每个分支的 spawn 第一参数都是安装期固定字面量路径（过审形态：无动态程序名、无 shell）
  let child: ReturnType<typeof spawn>;
  try {
    switch (key) {
      case 'edge86':
        child = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args, { windowsHide: true });
        break;
      case 'edge':
        child = spawn('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', args, { windowsHide: true });
        break;
      case 'chrome':
        child = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', args, { windowsHide: true });
        break;
      case 'chrome86':
        child = spawn('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', args, { windowsHide: true });
        break;
      case 'macEdge':
        child = spawn('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', args);
        break;
      case 'macChrome':
        child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args);
        break;
      case 'macChromium':
        child = spawn('/Applications/Chromium.app/Contents/MacOS/Chromium', args);
        break;
      case 'linuxMsedge':
        child = spawn('/usr/bin/msedge', args);
        break;
      case 'linuxChromium':
        child = spawn('/usr/bin/chromium', args);
        break;
      case 'linuxChromiumBrowser':
        child = spawn('/usr/bin/chromium-browser', args);
        break;
      case 'linuxChrome':
        child = spawn('/usr/bin/google-chrome', args);
        break;
      case 'linuxOptChrome':
        child = spawn('/opt/google/chrome/chrome', args);
        break;
    }
  } catch {
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, reason: 'convertFailed' };
  }
  const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, timeoutMs);
  const ok = await waitForExit(child, timer, () => {
    try { return fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 0; } catch { return false; }
  });
  // 一次性 profile 清理（失败静默；系统临时目录会周期清理）
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  return ok ? { ok: true, pdfPath } : { ok: false, reason: 'convertFailed' };
}
