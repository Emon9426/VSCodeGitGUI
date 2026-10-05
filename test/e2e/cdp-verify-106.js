/**
 * Issue #106 实机验证：push 被拒「拉取并推送」记住选择（autoPullOnReject）。
 * 前置:%TEMP%/gb104-e2e/gb104a fixture（phase a 同款：本地 l.txt / 远端 r.txt 不同文件可干净合并）
 * 用法:项目根 node test/e2e/cdp-verify-106.js <port>   （脚本自管 VS Code 实例生命周期）
 *
 * 脚手架要点（踩坑记录，勿回退）：
 *  - 外部 reset 后前端刷新不可靠（fetch 触发可靠、纯 update-ref 不触发）且被拒场景要求
 *    origin/main 停在 base（不能 fetch 同步）→ 每轮 reset 后重启全新 VS Code 实例（104 脚本模式）
 *  - 脚本退出会连带杀死 CDP 宿主实例（playwright 断开）→ 每轮 freshSession 自杀+重启
 *  - 链路完成后 Pull Summary 是常驻 modal（.gg-modal-overlay），污染 confirmDialog 断言
 *    → confirmDialog 一律按文本判定（远端有新提交/new commits）
 *  - 本地 bare 仓库 pull/push 毫秒级完成，网络模态闪现无法稳定捕捉 → 链路结果用
 *    bare main 硬校验（merge commit 落地）+ 徽标清零，不以模态可见性为断言
 *
 *  A:默认关——被拒通知双按钮（拉取并推送+以后自动），点「以后自动」→已记住 toast+
 *    本次自动走链完成（bare 落 merge、徽标清零），配置写入
 *  B:配置开——二次被拒不弹通知，自动 pull→push 完成全链（bare 硬校验）
 *  C:配置开——事前拦截(behind>0)同语义：不弹 behind 确认框直接走链完成（bare 硬校验）
 *  D:配置关(settings.json false)——被拒恢复询问形态（双按钮通知回归）
 *  E:配置关——事前拦截恢复 behind 确认框（按文本判定）
 */
const { chromium } = require('playwright-core');
const WebSocket = require('ws');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const PORT = (() => {
  const raw = process.argv[2] || '9252';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
const GB = path.join(os_tmp(), 'gb104-e2e', 'gb104a');
const WORK = path.join(GB, 'work');
const BARE = path.join(GB, 'origin.git');
const SETTINGS = path.join(os_tmp(), 'gb104-e2e', 'vscode-user-106', 'User', 'settings.json');
const USER_DATA = path.join(os_tmp(), 'gb104-e2e', 'vscode-user-106');   // 勿用 SETTINGS.split('User')——C:\Users 的 "User" 会被误切
const CODE = 'C:\\Users\\Emon\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe';
const PROJ = process.cwd();

function os_tmp() {
  const t = process.env.TEMP || process.env.TMP || path.join(process.env.USERPROFILE || 'C:\\Users\\x', 'AppData', 'Local', 'Temp');
  return t.replace(/\\/g, '/');
}

let seq = 0;
const evalRaw = (ws, expr) => new Promise((res) => {
  const id = ++seq;
  ws.once('message', raw => { const m = JSON.parse(raw); if (m.id === id) res(m.result?.result?.value); });
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, cond, detail) => { results.push({ name, pass: !!cond }); console.log((cond ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')); };
const waitEval = async (E, js, timeout, step = 400) => {
  for (let t = 0; t < timeout; t += step) {
    if (await E(js).catch(() => false)) return true;
    await sleep(step);
  }
  return false;
};
const git = (cwd, cmd) => execSync(`git -C "${cwd}" ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// fixture 拓扑自动探测：local=含 "local ahead" 的 HEAD、base=其父、remote=bare 里含 "remote ahead" 的提交
const SHAS = (() => {
  const localLine = git(WORK, 'log --oneline -3').split('\n').find(l => /local ahead/i.test(l));
  const local = localLine ? localLine.slice(0, 7) : git(WORK, 'rev-parse --short HEAD').trim();
  const base = git(WORK, `rev-parse --short ${local}^`).trim();
  const remoteLine = git(BARE, 'log --oneline main').split('\n').find(l => /remote ahead/i.test(l));
  if (!remoteLine) throw new Error('fixture 缺少 remote ahead 提交（请重建 gb104a）');
  return { local, base, remote: remoteLine.slice(0, 7) };
})();

/** 重置 fixture：mode='rejected'（origin/main 回 base，走服务端被拒）| 'behind'（origin/main=远端实际，走事前拦截） */
function reset(mode) {
  try { git(WORK, 'merge --abort'); } catch { /* 无合并在途 */ }
  git(WORK, `reset --hard ${SHAS.local}`);
  try { git(WORK, 'clean -fd'); } catch { /* 无未跟踪 */ }
  git(BARE, `update-ref refs/heads/main ${SHAS.remote}`);
  if (mode === 'behind') git(WORK, 'fetch origin');
  git(WORK, `update-ref refs/remotes/origin/main ${mode === 'behind' ? SHAS.remote : SHAS.base}`);
}

/** bare main 是否已收到本轮合并推送（链路完成的硬证据） */
const bareHasMerge = () => /^.{7,} (Merge|自动合并)/i.test(git(BARE, 'log --oneline -1').trim());

/** 杀掉并重启本端口 VS Code 实例，返回新会话的 E()（含面板打开与 webview 定位） */
async function freshSession() {
  // 子命令一律绝对路径：脚本常从 Git Bash 启动，node 继承的 PATH 可能不含 System32，
  // 相对路径下 powershell/cmd 直接 ENOENT 且被 try 吞掉（曾致杀/起从未执行、全程复用旧实例）；
  // 杀进程经 -EncodedCommand 下发（execSync 默认经 cmd 转发，内嵌引号会被吃掉）
  const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const psScript = `Get-CimInstance Win32_Process -Filter "name='Code.exe'" | Where-Object { $_.CommandLine -match '${PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try {
    execSync(`"${PS}" -NoProfile -EncodedCommand ${Buffer.from(psScript, 'utf16le').toString('base64')}`, { stdio: 'ignore' });
  } catch { /* 无旧实例 */ }
  await sleep(4500);   // Stop-Process -Force 后 user-data-dir 锁释放需缓冲，过早起会被单实例检测吞掉
  const userDataDir = USER_DATA;
  let up = false;
  for (let attempt = 0; attempt < 3 && !up; attempt++) {
    // spawn 参数数组直达 CreateProcess：不经 shell，绕开 cmd/start 对引号与 = 后引号的解析玄学
    spawn(CODE, [
      '--disable-workspace-trust', '--sync', 'off',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      `--extensionDevelopmentPath=${PROJ}`,
      WORK,
    ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    for (let i = 0; i < 25; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true).catch(() => false)) { up = true; break; }
      await sleep(1000);
    }
    if (!up) await sleep(3000);   // 未就绪：可能锁竞态被吞，重试启动
  }
  if (!up) throw new Error('VS Code 实例未能启动（CDP 未就绪）');
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const page = b.contexts()[0].pages().find(p => !p.url().includes('devtools')) || b.contexts()[0].pages()[0];
  await page.bringToFront();
  let opened = false;
  for (let i = 0; i < 30 && !opened; i++) {
    opened = await page.evaluate(() => {
      const ab = document.getElementById('workbench.parts.activitybar');
      const li = ab && [...ab.querySelectorAll('li.action-item')].find(el => {
        const a = el.querySelector('a');
        return /GitBoard/i.test(a?.getAttribute('aria-label') || a?.title || '');
      });
      if (li) { li.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); li.click(); return true; }
      return false;
    }).catch(() => false);
    if (!opened) await sleep(1000);
  }
  if (!opened) throw new Error('GitBoard 面板未能打开');
  for (let i = 0; i < 40; i++) {
    const ts = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    for (const t of ts.filter(t => t.type === 'iframe' && t.webSocketDebuggerUrl)) {
      const ws = new WebSocket(t.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise(r => { ws.once('open', r); ws.once('error', r); });
      if (ws.readyState !== 1) continue;
      const W = (js) => `(() => { const d = globalThis.document.querySelector('#active-frame')?.contentDocument; if (!d) return null; const document = d; return (${js}); })()`;
      if (await evalRaw(ws, W(`!!document.querySelector('.gg-side')`)).catch(() => false)) return (js) => evalRaw(ws, W(js));
      ws.close();
    }
    await sleep(500);
  }
  throw new Error('webview 帧未找到');
}

const abBadge = (E) => E(`document.querySelector('.gg-side-item.branch.head .gg-ab')?.textContent || 'none'`);
/** 起点就绪=分支行渲染且推送按钮可点（徽标值受 ahead/behind 计算时序影响，不作硬断言） */
const waitReady = (E) => waitEval(E,
  `(() => { const r = document.querySelector('.gg-side-item.branch.head'); const b = document.querySelector('[data-kind=push]'); return !!r && !!b && !b.disabled; })()`, 25000);
const waitBehind = (E) => waitEval(E,
  `(() => { const r = document.querySelector('.gg-side-item.branch.head .gg-ab'); return !!r && /↓/.test(r.textContent || ''); })()`, 25000);
const waitChainDone = (E) => waitEval(E,
  `(() => { const r = document.querySelector('.gg-side-item.branch.head'); return !!r && !r.querySelector('.gg-ab'); })()`, 30000);
const clickPush = (E) => E(`document.querySelector('[data-kind=push]')?.click()`);
const BEHIND_MODAL = `[...document.querySelectorAll('.gg-modal-overlay')].some(x => /remote has new commits|远端有新提交/i.test(x.textContent || ''))`;

(async () => {
  // ---------------- A:默认关——双按钮 → 以后自动 → 记住+走链 ----------------
  reset('rejected');
  const EA = await freshSession();
  check('A:起点就绪(ahead 徽标)', await waitReady(EA), await abBadge(EA));
  await clickPush(EA);
  check('A:被拒通知出现', await waitEval(EA, `!!document.querySelector('.gg-notif.error')`, 12000));
  const twoBtns = await EA(`(() => {
    const bs = [...document.querySelectorAll('.gg-notif.error .gg-notif-acts button')];
    return { n: bs.length, primary: bs.find(x => x.classList.contains('primary'))?.textContent || '', second: bs.filter(x => !x.classList.contains('primary')).map(x => x.textContent).join(',') };
  })()`);
  check('A:双按钮=拉取并推送(primary)+以后自动', twoBtns && twoBtns.n === 2 && /拉取并推送|pull and push/i.test(twoBtns.primary) && /以后自动|always auto-pull/i.test(twoBtns.second), JSON.stringify(twoBtns));
  check('A:点推送后无自动 pull(配置关只弹通知)', !(await EA(`!!document.querySelector('.gg-net-overlay')`)));
  await EA(`(() => { const btn = [...document.querySelectorAll('.gg-notif.error .gg-notif-acts button')].find(x => /以后自动|always auto-pull/i.test(x.textContent || '')); if (btn) btn.click(); return !!btn; })()`);
  check('A:已记住 toast(success 含文案)', await waitEval(EA, `[...document.querySelectorAll('.gg-notif.success .gg-notif-title')].some(x => /已记住|remembered/i.test(x.textContent || ''))`, 6000),
    await EA(`document.querySelector('.gg-notif.success .gg-notif-title')?.textContent || ''`));
  check('A:链完成(徽标清零+bare 落 merge)', await waitChainDone(EA) && bareHasMerge(), await abBadge(EA) + ' | bare: ' + git(BARE, 'log --oneline -1').trim());

  // ---------------- B:配置开——二次被拒不弹通知直接走链 ----------------
  reset('rejected');
  const EB = await freshSession();
  check('B:起点就绪(ahead 徽标)', await waitReady(EB), await abBadge(EB));
  await clickPush(EB);
  check('B:被拒不弹询问(error 通知不出现)', !(await waitEval(EB, `!!document.querySelector('.gg-notif.error')`, 4000)));
  check('B:全链自动完成(徽标清零+bare 落 merge)', await waitChainDone(EB) && bareHasMerge(), await abBadge(EB) + ' | bare: ' + git(BARE, 'log --oneline -1').trim());

  // ---------------- C:配置开——事前拦截(behind>0)同语义 ----------------
  reset('behind');
  const EC = await freshSession();
  check('C:起点就绪(behind 徽标可见)', await waitBehind(EC), await abBadge(EC));
  await clickPush(EC);
  const cHit = await waitEval(EC, BEHIND_MODAL, 3000);
  check('C:不弹 behind 确认框(同语义直接走链)', !cHit,
    cHit ? await EC(`[...document.querySelectorAll('.gg-modal-overlay')].map(x => (x.textContent || '').slice(0, 60)).join(' || ')`) : '');
  check('C:全链自动完成(徽标清零+bare 落 merge)', await waitChainDone(EC) && bareHasMerge(), await abBadge(EC) + ' | bare: ' + git(BARE, 'log --oneline -1').trim());

  // ---------------- D:配置关(settings.json)——被拒恢复询问形态 ----------------
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify({ 'gitboard.push.autoPullOnReject': false }, null, 2));
  reset('rejected');
  const ED = await freshSession();
  check('D:起点就绪(ahead 徽标)', await waitReady(ED), await abBadge(ED));
  await clickPush(ED);
  const askBack = await waitEval(ED, `!!document.querySelector('.gg-notif.error')`, 12000);
  const twoAgain = askBack ? await ED(`(() => {
    const bs = [...document.querySelectorAll('.gg-notif.error .gg-notif-acts button')];
    return bs.length === 2 && /拉取并推送|pull and push/i.test(bs.find(x => x.classList.contains('primary'))?.textContent || '') && /以后自动|always auto-pull/i.test(bs.filter(x => !x.classList.contains('primary')).map(x => x.textContent).join(''));
  })()`) : false;
  check('D:被拒恢复询问形态(双按钮通知回归)', askBack && twoAgain);

  // ---------------- E:配置关——事前拦截恢复 behind 确认框 ----------------
  reset('behind');
  const EE = await freshSession();
  check('E:起点就绪(behind 徽标可见)', await waitBehind(EE), await abBadge(EE));
  await clickPush(EE);
  check('E:恢复 behind 确认框(文本判定)', await waitEval(EE, BEHIND_MODAL, 8000),
    await EE(`document.querySelector('.gg-modal-overlay')?.textContent?.slice(0, 40) || ''`));

  const fail = results.filter(r => !r.pass).length;
  console.log(`\n#106 实机验证:${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
})();
