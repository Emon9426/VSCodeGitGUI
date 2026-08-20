/**
 * Git 命令执行器（设计方案 6.1）：
 * - 参数数组传递（无 shell 拼接），完整继承 process.env（含 VS Code 注入的 askpass 凭据变量）
 * - 只读命令默认 30s 超时、8MB 输出上限；网络命令流式进度、可取消
 */
import { spawn, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface ExecOpts {
  timeoutMs?: number;                     // 缺省 30s；传 0 表示无超时（网络操作）
  maxBytes?: number;                      // stdout 上限，默认 8MB
  onStderrLine?: (line: string) => void;  // --progress 进度行走 stderr
  registerChild?: (c: ChildProcess) => void;
  /** 追加/覆盖环境变量（合并进 process.env），如 hook 防卡死的 GIT_TERMINAL_PROMPT=0 */
  env?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export type GitErrorCode =
  | 'E_GIT_NOT_FOUND' | 'E_GIT_EXIT' | 'E_TIMEOUT' | 'E_CANCELLED';

export class GitError extends Error {
  constructor(
    public readonly code: GitErrorCode,
    message: string,
    public readonly exitCode?: number,
    public readonly command?: string,
    public readonly stderrTail?: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export function isGitError(e: unknown): e is GitError {
  return e instanceof GitError;
}

export class GitExecutor {
  constructor(private readonly gitPath: string) {}

  /** 探测顺序：设置 gitPath → 内置 Git 扩展提供的路径 → PATH */
  static async detect(configuredPath: string, builtinGitPath?: string): Promise<GitExecutor> {
    const candidates: string[] = [];
    if (configuredPath) candidates.push(configuredPath);
    if (builtinGitPath) candidates.push(builtinGitPath);
    candidates.push('git');

    for (const cand of candidates) {
      try {
        const probe = await rawExec(cand, ['--version'], 8000);
        if (probe.exitCode === 0) return new GitExecutor(cand);
      } catch { /* 尝试下一个候选 */ }
    }
    throw new GitError('E_GIT_NOT_FOUND', `git executable not found (tried: ${candidates.join(', ')})`);
  }

  get path(): string { return this.gitPath; }

  /**
   * 在指定仓库根执行 git 命令。
   * 公共参数：-C root、--no-optional-locks（只读不抢 index 锁）、core.quotepath=false（中文路径）。
   */
  exec(root: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const fullArgs = ['-C', root, '--no-optional-locks', '-c', 'core.quotepath=false', ...args];
    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(this.gitPath, fullArgs, {
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        windowsHide: true,
      });
      opts.registerChild?.(child);

      const outDec = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      let stdout = '';
      let stderr = '';
      let truncated = false;
      let pending = '';
      const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
      let settled = false;

      const timer = opts.timeoutMs === 0
        ? undefined
        : setTimeout(() => finish(new GitError('E_TIMEOUT', `git ${args[0]} timed out after ${opts.timeoutMs ?? 30000}ms`)), opts.timeoutMs ?? 30000);

      const finish = (err?: Error, result?: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err); else resolve(result!);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < maxBytes) stdout += outDec.write(chunk);
        if (stdout.length >= maxBytes) {
          truncated = true;
          child.stdout?.destroy();
          child.kill();
        }
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = errDec.write(chunk);
        if (stderr.length < 64 * 1024) stderr += text;
        if (opts.onStderrLine) {
          // git --progress 用 \r 原地刷新进度，需按 \r 也切行
          pending += text.replace(/\r/g, '\n');
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const l of lines) if (l.trim()) opts.onStderrLine(l.trim());
        }
      });
      child.on('error', (err) => {
        const ge = new GitError('E_GIT_NOT_FOUND', String((err as Error).message));
        finish(ge);
      });
      child.on('close', (code) => {
        if (pending && opts.onStderrLine && pending.trim()) opts.onStderrLine(pending.trim());
        if (settled) return;
        if (code === 0) {
          finish(undefined, { stdout, stderr, exitCode: 0, truncated });
        } else if (code === null && truncated) {
          finish(undefined, { stdout, stderr, exitCode: 0, truncated: true });
        } else {
          const tail = stderr.split('\n').slice(-8).join('\n').trim();
          finish(new GitError('E_GIT_EXIT', `git ${args[0]} exited with ${code ?? 'signal'}: ${tail || 'no stderr'}`, code ?? undefined, `git ${args.join(' ')}`, tail));
        }
      });
    });
  }
}

/** 无仓库上下文的裸执行（仅用于 --version 探测） */
function rawExec(cmd: string, args: string[], timeoutMs: number): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1 }); });
  });
}
