/**
 * watcher 探针：完全复刻 RepoWatcher 的监视与过滤逻辑，
 * 在临时仓库上实测 git commit / fetch(pull) 产生的事件能否被捕获并触发全量刷新判定。
 * 用法：node test/watch-probe.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const IGNORE_RE = /(^|[\\/])(objects|logs|hooks|info|branches|worktrees)([\\/]|$)|\.lock$|COMMIT_EDITMSG$|ORIG_HEAD$|FETCH_HEAD$/;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-probe-'));
const origin = path.join(base, 'origin.git');
const repo = path.join(base, 'repo');
const run = (cwd, cmd) => execSync(cmd, { cwd, stdio: 'pipe' }).toString();

run(base, `git init --bare -b main "${origin}"`);
run(base, `git init -b main "${repo}"`);
run(repo, 'git config user.email p@p');
run(repo, 'git config user.name p');
run(repo, 'git remote add origin ' + origin.replace(/\\/g, '/'));
fs.writeFileSync(path.join(repo, 'a.txt'), '1');
run(repo, 'git add a.txt');
run(repo, 'git commit -m init');
run(repo, 'git push -q -u origin main');
console.log('[setup] 临时仓库就绪:', repo);

// ---- 与 RepoWatcher.start() 相同的监视逻辑 ----
const gitDir = path.join(repo, '.git');
const pendingFiles = new Set();
let watcherErrors = 0;
let rawCount = 0;
const fire = (file) => {
  rawCount++;
  const rel = String(file ?? '').replace(/\\/g, '/');
  if (rel && IGNORE_RE.test(rel)) return;
  if (rel) pendingFiles.add(rel);
};
const w = fs.watch(gitDir, { recursive: true }, (_e, file) => fire(file));
w.on('error', e => { watcherErrors++; console.log('[watch ERROR]', e); });

// 远端造一个新提交（模拟同事推送）：bare 仓库用 commit-tree + update-ref
{
  const g = `git --git-dir="${origin}"`;
  const tree = run(base, `${g} log -1 --format=%T main`).trim();
  const next = run(base, `echo remote-new | ${g} commit-tree ${tree} -p main -F -`).trim();
  run(base, `${g} update-ref refs/heads/main ${next}`);
}

const steps = [
  ['commit', () => run(repo, 'git commit --allow-empty -m probe-commit')],
  ['pull',   () => run(repo, 'git pull -q --no-edit origin main')],
  ['外部fetch', () => run(repo, 'git fetch -q origin')],
];
let i = 0;
const tick = setInterval(() => {
  if (i >= steps.length) return;
  const [name, op] = steps[i++];
  pendingFiles.clear();
  const before = rawCount;
  try { op(); } catch (e) { console.log(`[${name}] 操作失败:`, e.message); return; }
  // 防抖窗口 250ms 后检查
  setTimeout(() => {
    const files = [...pendingFiles];
    const indexOnly = files.length > 0 && files.every(f => f === 'index');
    console.log(`[${name}] 原始事件=${rawCount - before} 过滤后=${JSON.stringify(files)} indexOnly=${indexOnly} → ${indexOnly ? '轻量' : '全量refresh'}`);
  }, 300);
}, 1200);

setTimeout(() => {
  clearInterval(tick);
  w.close();
  console.log(`[done] 原始事件总数=${rawCount} watcher错误=${watcherErrors}`);
  fs.rmSync(base, { recursive: true, force: true });
}, 1200 * (steps.length + 1) + 1500);
