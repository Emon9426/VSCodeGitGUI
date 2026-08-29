/**
 * 操作执行器（设计方案 6.4 / 6.5）：
 * 每仓库写操作串行队列、进度流式转发、可取消。
 */
import type { ChildProcess } from 'child_process';
import { GitError, type GitExecutor } from '../git/executor';

export type ResetMode = 'soft' | 'mixed' | 'hard';
export type PullStrategy = 'merge' | 'rebase' | 'ff-only';

export interface OpSpec {
  kind: 'fetch' | 'pull' | 'push' | 'reset' | 'checkout'
  | 'stage' | 'unstage' | 'discard' | 'discardClean' | 'commit'
  | 'resolveConflict' | 'commitNoEdit'
  | 'mergeAbort' | 'mergeContinue' | 'resolveDelete'
  | 'tagCreate' | 'tagDelete' | 'tagDeleteRemote' | 'tagPush'
  | 'moveFolder' | 'renamePath' | 'deletePaths';   // 文件页操作（v0.14）
  /** 依 kind 不同 */
  all?: boolean;               // fetch
  remote?: string;
  branch?: string;
  prune?: boolean;             // fetch
  strategy?: PullStrategy;     // pull
  autostash?: boolean;         // pull
  setUpstream?: boolean;       // push
  sha?: string;                // reset / checkout(detached) / tagCreate
  mode?: ResetMode;            // reset
  ref?: string;                // checkout
  detached?: boolean;          // checkout
  trackFrom?: { name: string; remoteBranch: string };  // checkout 远程分支为本地
  paths?: string[];            // stage / unstage / discard / discardClean / resolveConflict
  messageFile?: string;        // commit：-F 临时文件（调用方负责创建与清理）
  amend?: boolean;             // commit：修订上次提交
  ours?: boolean;              // resolveConflict：true=保留本地版本
  rebase?: boolean;            // mergeAbort/mergeContinue：rebase 变体（否则按 merge）
  name?: string;               // tag*：标签名 / renamePath：新文件名
  message?: string;            // tagCreate：附注信息（非空=附注标签）
  srcs?: string[];             // moveFolder：多选源路径（批量 git mv）
  dst?: string;                // moveFolder：目标目录
  path?: string;               // renamePath：原路径
}

export interface OpOutcome {
  ok: boolean;
  message?: string;
  outputTail?: string;
  /** 成功时的 stdout 尾部行（pull 的 "Already up to date." 等结果判定用） */
  stdoutTail?: string;
}

const PCT_RE = /(\d+)%/;

export class OpRunner {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly children = new Map<number, ChildProcess>();
  private readonly cancelled = new Set<number>();

  constructor(
    private readonly exec: GitExecutor,
    /** 队列空隙时的回调（用于 UI 释放"进行中"状态） */
    private readonly onIdle?: () => void,
  ) {}

  cancel(opId: number): void {
    this.cancelled.add(opId);
    this.children.get(opId)?.kill();
  }

  /** 串行入队并执行；onProgress 收到本地化文本与可选百分比 */
  async run(
    root: string,
    spec: OpSpec,
    opId: number,
    onProgress: (text: string, pct?: number) => void,
    buildDone: (ok: boolean) => string,
  ): Promise<OpOutcome> {
    const prev = this.queues.get(root) ?? Promise.resolve();
    const task = prev.catch(() => undefined).then(() => this.execute(root, spec, opId, onProgress, buildDone));
    let release: () => void;
    const gate = new Promise<void>(r => { release = r; });
    this.queues.set(root, gate as Promise<void>);
    const result = await task;
    release!();
    if (this.queues.get(root) === gate) this.queues.delete(root);
    if (this.children.get(opId)) this.children.delete(opId);
    this.onIdle?.();
    return result;
  }

  private async execute(
    root: string,
    spec: OpSpec,
    opId: number,
    onProgress: (text: string, pct?: number) => void,
    buildDone: (ok: boolean) => string,
  ): Promise<OpOutcome> {
    const cmds = buildArgs(spec);
    let lastLine = '';
    // 网络/提交（hooks 可能耗时）不设超时；stage/discard 类秒级操作用默认 30s
    const noTimeout = spec.kind === 'fetch' || spec.kind === 'pull' || spec.kind === 'push'
      || spec.kind === 'commit' || spec.kind === 'commitNoEdit' || spec.kind === 'mergeContinue'
      || spec.kind === 'tagPush' || spec.kind === 'tagDeleteRemote';
    // commit/continue 类可能触发 hooks 与编辑器：禁止交互式提示防挂死（提示失败改走终端）
    const env = spec.kind === 'commit' || spec.kind === 'commitNoEdit' || spec.kind === 'mergeContinue'
      ? { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } : undefined;
    try {
      let r;
      for (const args of cmds) {
        r = await this.exec.exec(root, args, {
          timeoutMs: noTimeout ? 0 : undefined,
          maxBytes: 4 * 1024 * 1024,
          env,
          registerChild: (c) => this.children.set(opId, c),
          onStderrLine: (line) => {
            const cleaned = line.replace(/[\r ]+$/, '');
            if (!cleaned || cleaned === lastLine) return;
            lastLine = cleaned;
            const m = PCT_RE.exec(cleaned);
            onProgress(cleaned, m ? Number(m[1]) : undefined);
          },
        });
      }
      const warn = r!.stderr
        .split('\n').map(s => s.trim()).filter(Boolean)
        .filter(l => !l.startsWith('remote:')).slice(0, 3).join(' ');
      const stdoutTail = r!.stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(-6).join('\n');
      return { ok: true, message: buildDone(true) + (warn ? ` — ${warn}` : ''), stdoutTail };
    } catch (e) {
      if (this.cancelled.delete(opId) || (e instanceof GitError && e.code === 'E_TIMEOUT')) {
        return { ok: false, message: 'cancelled' };
      }
      const tail = e instanceof GitError ? e.stderrTail : String(e);
      return { ok: false, message: buildDone(false), outputTail: tail };
    }
  }
}

function buildArgs(spec: OpSpec): string[][] {
  switch (spec.kind) {
    case 'fetch': {
      const args = ['fetch', '--progress'];
      if (spec.all) args.push('--all');
      if (spec.prune) args.push('--prune');
      if (!spec.all && spec.remote) args.push(spec.remote);
      return [args];
    }
    case 'pull': {
      const args = ['pull', '--progress'];
      if (spec.strategy === 'rebase') args.push('--rebase');
      else if (spec.strategy === 'ff-only') args.push('--ff-only');
      if (spec.autostash) args.push('--autostash');
      if (spec.remote) args.push(spec.remote);
      if (spec.branch) args.push(spec.branch);
      return [args];
    }
    case 'push': {
      const args = ['push', '--progress'];
      if (spec.setUpstream) args.push('-u');
      args.push(spec.remote ?? 'origin', spec.branch ?? 'HEAD');
      return [args];
    }
    case 'reset':
      return [['reset', `--${spec.mode ?? 'mixed'}`, spec.sha ?? 'HEAD']];
    case 'checkout': {
      if (spec.trackFrom) {
        return [['checkout', '-b', spec.trackFrom.name, '--track', spec.trackFrom.remoteBranch]];
      }
      const args = ['checkout'];
      if (spec.detached) args.push('--detach');
      args.push(spec.ref ?? spec.sha ?? 'HEAD');
      return [args];
    }
    // ---------- 工作副本（Commit 功能） ----------
    case 'stage':
      return [spec.all ? ['add', '-A'] : ['add', '--', ...(spec.paths ?? [])]];
    case 'unstage':
      return [['restore', '--staged', '--', ...(spec.paths ?? [])]];
    case 'discard':
      return [['restore', '--source=HEAD', '--staged', '--worktree', '--', ...(spec.paths ?? [])]];
    case 'discardClean':
      return [['clean', '-fd', '--', ...(spec.paths ?? [])]];
    case 'commit': {
      const args = ['commit', '--cleanup=strip'];
      if (spec.amend) args.push('--amend');
      if (spec.messageFile) args.push('-F', spec.messageFile);
      return [args];
    }
    // ---------- 冲突解决 / 合并完成 ----------
    case 'resolveConflict': {
      const side = spec.ours ? '--ours' : '--theirs';
      const paths = spec.paths ?? [];
      // 取选定侧版本并暂存；命令序列由 execute 串行执行
      return [
        ['checkout', side, '--', ...paths],
        ['add', '--', ...paths],
      ];
    }
    case 'commitNoEdit':
      // 冲突全部解决后完成合并（沿用 MERGE_MSG 默认信息）
      return [['commit', '--no-edit']];
    // ---------- 合并解决器（v0.10） ----------
    case 'mergeAbort':
      // 中止并还原到合并/变基前（按会话类型分派）
      return [spec.rebase ? ['rebase', '--abort'] : ['merge', '--abort']];
    case 'mergeContinue':
      // rebase/cherry-pick：继续重放（GIT_EDITOR=true 防编辑器挂起，见 execute 的 env）
      return [spec.rebase ? ['rebase', '--continue'] : ['cherry-pick', '--continue']];
    case 'resolveDelete':
      // 一方删除场景的"采纳删除"：从 index 与工作副本移除
      return [['rm', '--', ...(spec.paths ?? [])]];
    // ---------- 标签 ----------
    case 'tagCreate': {
      const name = spec.name ?? '';
      const target = spec.sha ?? 'HEAD';
      return [spec.message
        ? ['tag', '-a', name, '-m', spec.message, target]
        : ['tag', name, target]];
    }
    case 'tagDelete':
      return [['tag', '-d', spec.name ?? '']];
    case 'tagDeleteRemote':
      return [['push', '--progress', spec.remote ?? 'origin', `:refs/tags/${spec.name ?? ''}`]];
    case 'tagPush':
      return [['push', '--progress', spec.remote ?? 'origin', `refs/tags/${spec.name ?? ''}`]];
    // ---------- 文件页操作（v0.14） ----------
    case 'moveFolder': {
      // 多选批量移动：逐对 git mv（命令序列由 execute 串行执行）
      const dst = spec.dst ?? '.';
      return (spec.srcs ?? []).map(src => ['mv', '--', src, dst]);
    }
    case 'renamePath': {
      // 同目录重命名 = git mv（R100 识别确定性，历史自动跟随）
      const p = spec.path ?? '';
      const i = p.lastIndexOf('/');
      const next = i < 0 ? (spec.name ?? p) : p.slice(0, i + 1) + (spec.name ?? p.slice(i + 1));
      return [['mv', '--', p, next]];
    }
    case 'deletePaths':
      // 已跟踪文件/目录：git rm（进入待提交状态）；未跟踪项由 panel 先行磁盘删除
      return [['rm', '-r', '--', ...(spec.paths ?? [])]];
  }
}
