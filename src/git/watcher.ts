/**
 * .git 目录监视 + 防抖（设计方案 6.3）。
 * Windows/macOS 递归监视；Linux 退化为监视 .git 顶层 + refs。
 * 防抖窗口内收集变更文件名一并回调（v0.7.2：调用方按文件分类走轻量/全量刷新）。
 * v0.9.1：监听 fs.watch error（事件风暴/句柄丢失时 libuv 报错，无监听会变成
 * 扩展宿主未捕获异常或静默死亡），记录日志并限速自动重建。
 */
import * as fs from 'fs';
import * as path from 'path';

const IGNORE_RE = /(^|[\\/])(objects|logs|hooks|info|branches|worktrees)([\\/]|$)|\.lock$|COMMIT_EDITMSG$|ORIG_HEAD$|FETCH_HEAD$/;

/** error 后重建的最小间隔（防错误风暴下无限重建） */
const REBUILD_INTERVAL_MS = 30_000;

export class RepoWatcher {
  private watchers: fs.FSWatcher[] = [];
  private timer?: NodeJS.Timeout;
  private pendingFiles = new Set<string>();
  private disposed = false;
  private lastRebuildAt = 0;

  constructor(
    private readonly root: string,
    /** files：防抖窗口内变更的 .git 相对路径（已过滤 objects/locks 等） */
    private readonly onChange: (files: string[]) => void,
    /** 监视异常日志（扩展侧输出通道）；缺省仅计数 */
    private readonly onError?: (message: string) => void,
  ) {}

  start(): void {
    if (this.disposed) return;
    this.spawn();
  }

  private spawn(): void {
    const gitDir = path.join(this.root, '.git');
    const fire = (file?: string | null) => {
      const rel = String(file ?? '').replace(/\\/g, '/');
      if (rel && IGNORE_RE.test(rel)) return;
      if (rel) this.pendingFiles.add(rel);
      this.schedule();
    };
    const attach = (w: fs.FSWatcher): fs.FSWatcher => {
      w.on('error', err => this.onWatcherError(err));
      return w;
    };
    try {
      this.watchers.push(attach(fs.watch(gitDir, { recursive: true }, (_e, file) => fire(file))));
    } catch {
      // Linux：递归不可用，退化为顶层监视（refs 深层变化依赖操作后主动刷新兜底）
      try {
        this.watchers.push(attach(fs.watch(gitDir, (_e, file) => fire(file))));
        this.watchers.push(attach(fs.watch(path.join(gitDir, 'refs'), { recursive: true }, (_e, file) => fire(file ? `refs/${file}` : 'refs'))));
      } catch (e2) {
        this.onError?.(`[watch] start failed on ${gitDir}: ${String((e2 as Error)?.message ?? e2)}`);
      }
    }
  }

  /** 监视失效（缓冲区溢出、目录句柄丢失等）：关停残存句柄并限速重建 */
  private onWatcherError(err: unknown): void {
    if (this.disposed) return;
    this.onError?.(`[watch] error on ${this.root}/.git: ${String((err as Error)?.message ?? err)}`);
    for (const w of this.watchers) {
      try { w.close(); } catch { /* 已关闭 */ }
    }
    this.watchers = [];
    const now = Date.now();
    const since = now - this.lastRebuildAt;
    if (since < REBUILD_INTERVAL_MS) {
      // 错误风暴：间隔期满再试（否则若无后续事件，监视将永久失效）
      setTimeout(() => {
        if (!this.disposed && !this.watchers.length) this.spawn();
      }, REBUILD_INTERVAL_MS - since + 100);
      return;
    }
    this.lastRebuildAt = now;
    setTimeout(() => {
      if (!this.disposed && !this.watchers.length) this.spawn();
    }, 1000);
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
