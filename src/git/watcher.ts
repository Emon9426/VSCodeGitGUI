/**
 * .git 目录监视 + 防抖（设计方案 6.3）。
 * Windows/macOS 递归监视；Linux 退化为监视 .git 顶层 + refs。
 * 防抖窗口内收集变更文件名一并回调（v0.7.2：调用方按文件分类走轻量/全量刷新）。
 */
import * as fs from 'fs';
import * as path from 'path';

const IGNORE_RE = /(^|[\\/])(objects|logs|hooks|info|branches|worktrees)([\\/]|$)|\.lock$|COMMIT_EDITMSG$|ORIG_HEAD$|FETCH_HEAD$/;

export class RepoWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private pendingFiles = new Set<string>();
  private disposed = false;

  constructor(
    private readonly root: string,
    /** files：防抖窗口内变更的 .git 相对路径（已过滤 objects/locks 等） */
    private readonly onChange: (files: string[]) => void,
  ) {}

  start(): void {
    const gitDir = path.join(this.root, '.git');
    const fire = (file?: string | null) => {
      const rel = String(file ?? '').replace(/\\/g, '/');
      if (rel && IGNORE_RE.test(rel)) return;
      if (rel) this.pendingFiles.add(rel);
      this.schedule();
    };
    try {
      this.watchers.push(fs.watch(gitDir, { recursive: true }, (_e, file) => fire(file)));
    } catch {
      // Linux：递归不可用，退化为顶层监视（refs 深层变化依赖操作后主动刷新兜底）
      try {
        this.watchers.push(fs.watch(gitDir, (_e, file) => fire(file)));
        this.watchers.push(fs.watch(path.join(gitDir, 'refs'), { recursive: true }, (_e, file) => fire(file ? `refs/${file}` : 'refs')));
      } catch { /* 无能为力，等待手动刷新 */ }
    }
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const files = [...this.pendingFiles];
      this.pendingFiles.clear();
      this.onChange(files);
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
