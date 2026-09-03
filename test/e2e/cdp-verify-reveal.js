/**
 * 「在资源管理器中显示」真机验证（Issue #1/#2 修复；CDP + Shell COM 探针）。
 * 与其他 cdp-verify-* 同模式：连接已启动的 VS Code（隔离 profile + --extensionDevelopmentPath），
 * 本脚本不负责启动（启动命令由 prepare 打印，由操作者/上层脚本执行），便于门禁与复用。
 * 用法：
 *   node cdp-verify-reveal.js prepare              # 生成 %TEMP%\gb-e2e-reveal 夹具并打印启动命令
 *   node cdp-verify-reveal.js <port> spaced        # 场景① 含空格仓库（VS Code 已开在打印出的 test repo）
 *   node cdp-verify-reveal.js <port> long          # 场景② 长路径仓库（VS Code 已开在打印出的 plainrepo）
 * 断言：
 *   ① 含空格短路径 → 打开文件父目录而非 Documents（concat 形态 2026-09-01 实测会退化为 Documents）
 *   ② >259 长路径 → 定位最深 ≤259 祖先 + 成功 toast（无误报「已不存在」）
 * 安全约定：PowerShell 一律参数列表形态 + 模块级固定字面量命令体；HWND 列表纯数字白名单后
 * 经专用环境变量传入；本脚本自身不 spawn 任何程序。
 */
const { spawnSync, execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform !== 'win32') { console.log('SKIP: 仅 Windows 真机场景'); process.exit(0); }
// 与 cdp-verify-boot 同约定：node cdp-verify-reveal.js <port> spaced|long；prepare 单独占首参
const MODE = process.argv[2] === 'prepare' ? 'prepare' : (process.argv[3] || '');
const PORT = (() => {
  const raw = MODE === 'prepare' ? '9261' : (process.argv[2] || '9261');
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range 2000-65535');
  return raw;
})();
const EXT_DEV = path.resolve(__dirname, '..', '..');
const BASE = path.join(os.tmpdir(), 'gb-e2e-reveal');
const SEG = 'D'.repeat(58);
const EXPLORER_MAX_PATH = 259;

let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail ?? '' }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
const fileUrlOf = p => 'file:///' + path.resolve(p).replace(/\\/g, '/');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });
}
function mkRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q');
  git(root, 'config', 'core.longpaths', 'true');
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
}

// ---------- explorer 窗口探针（参数列表形态；命令体为固定字面量） ----------
const LIST_CMD = '$sh = New-Object -ComObject Shell.Application; $o = @(); foreach ($w in $sh.Windows()) { try { $o += ([string][int64]$w.HWND + [char]124 + [string]$w.LocationURL) } catch {} }; $o -join [char]10';
const CLOSE_CMD = '$sh = New-Object -ComObject Shell.Application; $want = $env:GB_HWND_LIST; foreach ($w in $sh.Windows()) { try { if ($want.Split([char]44) -contains [string][int64]$w.HWND) { $w.Quit() } } catch {} }';

function listWindows() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', LIST_CMD], { encoding: 'utf8', timeout: 15000 });
  try {
    return String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).map(line => {
      const i = line.indexOf('|');
      return { hwnd: Number(line.slice(0, i)), loc: line.slice(i + 1) };
    });
  } catch { return []; }
}
function closeWindows(hwnds) {
  if (!hwnds.length) return;
  // 白名单：HWND 全部为探针返回的纯数字；经专用环境变量传入，不进入命令体
  if (!hwnds.every(h => /^\d+$/.test(String(h)))) throw new Error('invalid hwnd list');
  spawnSync('powershell', ['-NoProfile', '-Command', CLOSE_CMD], { env: { ...process.env, GB_HWND_LIST: hwnds.join(',') }, timeout: 15000, stdio: ['ignore', 'ignore', 'ignore'] });
}

// ---------- prepare：夹具 + 打印启动命令 ----------
function prepare() {
  fs.rmSync(BASE, { recursive: true, force: true });
  // 场景①：含空格仓库
  const repoA = path.join(BASE, 'test repo');
  mkRepo(repoA);
  fs.mkdirSync(path.join(repoA, 'space dir'), { recursive: true });
  fs.writeFileSync(path.join(repoA, 'space dir', 'file.md'), 'v1\n');
  git(repoA, 'add', '.'); git(repoA, 'commit', '-q', '-m', 'spaced');
  fs.writeFileSync(path.join(repoA, 'space dir', 'file.md'), 'v2\n');
  // 场景②：无空格 >259 长路径仓库
  const repoB = path.join(BASE, 'plainrepo');
  mkRepo(repoB);
  let deep = repoB;
  for (let i = 0; i < 5; i++) { deep = path.join(deep, SEG + '_' + i); fs.mkdirSync(deep.length >= 248 ? '\\\\?\\' + deep : deep); }
  const longFile = path.join(deep, 'deep.md');
  fs.writeFileSync('\\\\?\\' + longFile, 'v1\n');
  git(repoB, 'add', '-A'); git(repoB, 'commit', '-q', '-m', 'long');
  fs.writeFileSync('\\\\?\\' + longFile, 'v2\n');
  const profile = path.join(BASE, 'profile');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false,
    'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
  }));
  console.log('夹具已生成。依次执行以下两步（各自跑完对应 verify 后关闭窗口再进行下一步）：');
  console.log('');
  console.log('[场景①/②] 启动命令（<dir> 分别替换为下面两行打印的目录）：');
  console.log('  ' + path.join(os.homedir(), 'AppData/Local/Programs/Microsoft VS Code/Code.exe')
    + ' --remote-debugging-port=' + PORT
    + ' --user-data-dir=' + profile + ' --extensions-dir=' + path.join(profile, 'exts')
    + ' --extensionDevelopmentPath=' + EXT_DEV + ' --disable-workspace-trust --skip-release-notes "<dir>"');
  console.log('  场景①目录: ' + repoA);
  console.log('  场景②目录: ' + repoB);
  console.log('随后依次: node ' + __filename + ' ' + PORT + ' spaced | long');
}

/** 连接 workbench 页并点开 GitBoard 主面板，返回 { page, E, ws } */
async function connectMain() {
  const b = await chromium.connectOverCDP('http://127.0.0.1:' + PORT);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  for (let i = 0; i < 15; i++) {
    const ok = await page.evaluate(() => {
      const bar = document.getElementById('workbench.parts.activitybar');
      const t = bar && [...bar.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return /仓库|Repositories|GitBoard/i.test(a?.getAttribute('aria-label') || a?.title || '');
      });
      if (t) { t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); t.click(); return true; }
      return false;
    }).catch(() => false);
    if (ok) break;
    await sleep(1200);
  }
  for (let i = 0; i < 30; i++) {
    const ts = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-viewseg')`)).catch(() => false)) return { page, E: js => evalRaw(ws, W(js)), ws };
      ws.close();
    }
    await sleep(800);
  }
  return null;
}

/** 工作副本选中目标行并点 reveal；返回 { locs, toasts } */
async function revealInWorkView(E, page, rel) {
  for (let i = 0; i < 12; i++) {
    const ok = await E(`(() => { const b = [...document.querySelectorAll('.gg-viewseg-btn')].find(b => /工作副本|Working Copy/i.test(b.textContent||'')); if (b) { b.click(); return true; } return false; })()`).catch(() => false);
    if (ok) break;
    await sleep(1000);
  }
  let picked = false;
  for (let i = 0; i < 20 && !picked; i++) {
    picked = await E(`(() => { const r = [...document.querySelectorAll('.gg-work-row')].find(r => (r.querySelector('.gg-work-fpath')?.title || '').endsWith(${JSON.stringify(rel)})); if (r) { r.click(); return true; } return false; })()`).catch(() => false);
    if (!picked) await sleep(1000);
  }
  if (!picked) return null;
  await sleep(1200);
  const before = listWindows().map(w => w.hwnd);
  const clicked = await E(`(() => { const b = [...document.querySelectorAll('.gg-work-dhead .gg-icon-btn')].find(b => /资源管理器|file manager/i.test(b.title || '')); if (b) { b.click(); return true; } return false; })()`);
  if (!clicked) return null;
  await sleep(3500);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.notifications-toasts .notification-toast')].map(t => t.textContent || '')).catch(() => []);
  const fresh = listWindows().filter(w => !before.includes(w.hwnd));
  const out = { locs: fresh.map(w => decodeURIComponent(w.loc || '')), toasts };
  await sleep(300);
  closeWindows(fresh.map(w => w.hwnd));
  return out;
}

(async () => {
  if (MODE === 'prepare') { prepare(); process.exit(0); }
  if (!['spaced', 'long'].includes(MODE)) {
    console.log('用法: node cdp-verify-reveal.js prepare | <port> spaced|long');
    process.exit(2);
  }
  const t0 = Date.now();

  if (MODE === 'spaced') {
    const repoA = path.join(BASE, 'test repo');
    const conn = await connectMain();
    check('① webview 就绪', !!conn, '请先用 prepare 打印的命令打开: ' + repoA);
    if (conn) {
      const r = await revealInWorkView(conn.E, conn.page, 'space dir/file.md');
      check('① reveal 已点击', !!r, r ? '' : '未找到目标行或按钮');
      if (r) {
        const parent = fileUrlOf(path.join(repoA, 'space dir'));
        check('① 打开的是文件父目录（不再退化为 Documents）', r.locs.some(l => l === parent), JSON.stringify(r.locs));
        check('① 无「已不存在」误报', !r.toasts.some(t => /不存在|not found/i.test(t)), r.toasts.join(' / ').slice(0, 80));
      }
      conn.ws.close();
    }
  } else if (MODE === 'long') {
    const repoB = path.join(BASE, 'plainrepo');
    let deep = repoB;
    for (let i = 0; i < 5; i++) deep = path.join(deep, SEG + '_' + i);
    const longFile = path.join(deep, 'deep.md');
    const rel = path.relative(repoB, longFile).replace(/\\/g, '/');
    const conn = await connectMain();
    check('② webview 就绪', !!conn, '请先用 prepare 打印的命令打开: ' + repoB);
    if (conn) {
      const r = await revealInWorkView(conn.E, conn.page, rel);
      check('② reveal 已点击', !!r, r ? '' : '未找到目标行或按钮');
      if (r) {
        let anc = longFile;
        while (anc.length > EXPLORER_MAX_PATH) anc = path.dirname(anc);
        const expectParent = fileUrlOf(path.dirname(anc));
        check('② 定位到最深可用祖先', r.locs.some(l => l === expectParent), '期望 ' + expectParent + '，实际 ' + JSON.stringify(r.locs));
        check('② 成功 toast（无误报「已不存在」）', r.toasts.some(t => /已在资源管理器中显示|Revealed/i.test(t)) && !r.toasts.some(t => /不存在|not found/i.test(t)), r.toasts.join(' / ').slice(0, 90));
      }
      conn.ws.close();
    }
  }

  const fails = results.filter(r => !r.pass).length;
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's；' + (fails ? 'REVEAL-VERIFY(' + MODE + ') FAIL x' + fails : 'REVEAL-VERIFY(' + MODE + ') ALL-PASS'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E ERROR:', e); process.exit(1); });
