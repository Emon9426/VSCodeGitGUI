/**
 * .git 目录监视 + 防抖（设计方案 6.3）。
 * Windows/macOS 递归监视；Linux 回退为监视 .git 顶层。
 */
import * as fs from 'fs';
import * as path from 'path';

const IGNORE_RE = /(^|[\\/])(objects|logs|hooks|info|branches|worktrees)([\\/]|$)|\.lock$|COMMIT_EDITMSG$|ORIG_HEAD$|FETCH_HEAD$/;

export class RepoWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private disposed = false;

  constructor(
    private readonly root: string,
    private readonly onChange: () => void,
  ) {}

  start(): void {
    const gitDir = path.join(this.root, '.git');
    const fire = (file?: string) => {
      if (file && IGNORE_RE.test(file.replace(/\\/g, '/'))) return;
      this.schedule();
    };
    try {
      this.watchers.push(fs.watch(gitDir, { recursive: true }, (_e, file) => fire(String(file ?? ''))));
    } catch {
      // Linux：递归不可用，退化为顶层监视（refs 深层变化依赖操作后主动刷新兜底）
      try {
        this.watchers.push(fs.watch(gitDir, (_e, file) => fire(String(file ?? ''))));
        this.watchers.push(fs.watch(path.join(gitDir, 'refs'), { recursive: true }, (_e, file) => fire(file ? `refs/${file}` : 'refs')));
      } catch { /* 无能为力，等待手动刷新 */ }
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onChange();
    }, 250);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers) {
      try { w.close(); } catch { /* 已关闭 */ }
    }
    this.watchers = [];
  }
}
