/**
 * Git 操作后快速校验（Issue #6 后续：意图-探针-判定）：
 * 操作退出码 0 后用廉价只读探针核对仓库实际状态是否符合该操作的意图，
 * 把"退出码成功但结果不对"（拉错分支 / 推错分支 / 拉取未合并 / HEAD 未按预期变化）
 * 从静默变成显式警告。
 *
 * - quick 档：全本地探针（rev-parse / for-each-ref / config），零网络成本；
 * - deep 档：pull/push 额外一次 ls-remote 比对远端真身——唯一能测出
 *   "fetch 路径陈旧（代理/镜像缓存旧引用）"的手段（8s 超时）。
 * - fail-open：探针异常/超时一律 unknown，绝不阻塞操作、绝不误报失败。
 *
 * 安全形态与 summary.ts 同款：execFile + 参数数组（绝不经 shell），
 * 命令与子命令全字面量，动态值（分支/标签名）经白名单校验后进参数数组。
 */
import { execFile } from 'child_process';
import type { OpSpec } from './runner';
import type { GitExecutor } from '../git/executor';

export type VerifyVerdict = 'pass' | 'warn' | 'unknown' | 'skip';
export type VerifyDepth = 'quick' | 'deep';

/** 校验上下文：操作前快照（commit 的 HEAD 对比；其余探针自取，不依赖缓存状态） */
export interface VerifyContext {
  headBefore?: string;
}

/** 结构化结果：panel 按 reason 选 i18n 文案与参数拼装 */
export interface VerifyResult {
  verdict: VerifyVerdict;
  reason?: 'behind' | 'ahead' | 'headUnchanged' | 'headMismatch' | 'tagMissing' | 'tagExists' | 'remoteDrift';
  n?: number;          // behind/ahead/未达提交数
  ref?: string;        // 上游短名（origin/main）
  name?: string;       // 标签名
}

/** 分支名白名单（git refname 合法字符子集，拒绝注入形态与控制字符） */
const BRANCH_RE = /^[\w][\w./-]{0,200}$/;
/** 标签名白名单（比分支宽：允许 # 等常见标签字符，仍拒绝空白与控制字符） */
const TAG_RE = /^[^\s\x00-\x1f]{1,200}$/;

/** for-each-ref 的 %(upstream:track,nobracket) 输出 → {ahead, behind}（纯函数，单测目标） */
export function parseTrack(s: string): { ahead: number; behind: number } {
  const ahead = s.match(/ahead (\d+)/);
  const behind = s.match(/behind (\d+)/);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** pull/push 的领先落后判定（纯函数，单测目标）：pull 不可 behind，push 不可 ahead */
export function judgeByTrack(kind: 'pull' | 'push', t: { ahead: number; behind: number }): VerifyResult {
  if (kind === 'pull' && t.behind > 0) return { verdict: 'warn', reason: 'behind', n: t.behind };
  if (kind === 'push' && t.ahead > 0) return { verdict: 'warn', reason: 'ahead', n: t.ahead };
  return { verdict: 'pass' };
}

/** commit 判定：HEAD 必须前进（amend 同样改变 sha） */
export function judgeHeadChanged(headBefore: string | undefined, headAfter: string): VerifyResult {
  if (!headBefore) return { verdict: 'unknown' };
  return headBefore === headAfter ? { verdict: 'warn', reason: 'headUnchanged' } : { verdict: 'pass' };
}

/** checkout/reset 判定：HEAD 必须等于预期 */
export function judgeHeadEquals(expected: string | undefined, headAfter: string): VerifyResult {
  if (!expected) return { verdict: 'unknown' };
  return expected === headAfter ? { verdict: 'pass' } : { verdict: 'warn', reason: 'headMismatch' };
}

/** tagCreate/tagDelete 判定：存在性符合预期 */
export function judgeTag(expectExists: boolean, exists: boolean): VerifyResult {
  if (exists === expectExists) return { verdict: 'pass' };
  return { verdict: 'warn', reason: expectExists ? 'tagMissing' : 'tagExists' };
}

export class OpVerifier {
  constructor(private readonly executor: GitExecutor) {}

  /** 操作成功（退出码 0）后的意图核对；off 由调用方拦截，此处只管 quick/deep */
  async verify(root: string, spec: OpSpec, ctx: VerifyContext, depth: VerifyDepth): Promise<VerifyResult> {
    try {
      switch (spec.kind) {
        case 'pull':
        case 'push':
          return await this.verifySync(root, spec.kind, depth);
        case 'commit':
          return judgeHeadChanged(ctx.headBefore, await this.headSha(root));
        case 'reset':
          return judgeHeadEquals(await this.revSha(root, spec.sha ?? 'HEAD'), await this.headSha(root));
        case 'checkout': {
          // trackFrom（新建跟踪分支）：HEAD=远端分支 tip；普通：HEAD=目标 ref/sha tip
          const target = spec.trackFrom ? spec.trackFrom.remoteBranch : (spec.ref ?? spec.sha);
          if (!target) return { verdict: 'skip' };
          return judgeHeadEquals(await this.revSha(root, target), await this.headSha(root));
        }
        case 'tagCreate': {
          const name = spec.name ?? '';
          if (!TAG_RE.test(name)) return { verdict: 'unknown' };
          const r = judgeTag(true, await this.tagExists(root, name));
          return r.verdict === 'warn' ? { ...r, name } : r;
        }
        case 'tagDelete': {
          const name = spec.name ?? '';
          if (!TAG_RE.test(name)) return { verdict: 'unknown' };
          const r = judgeTag(false, await this.tagExists(root, name));
          return r.verdict === 'warn' ? { ...r, name } : r;
        }
        default:
          return { verdict: 'skip' };   // fetch（已有 n 计数反馈）/ tagPush / tagDeleteRemote / 其余本地操作
      }
    } catch {
      return { verdict: 'unknown' };   // fail-open：探针异常不惩罚操作结果
    }
  }

  /** pull/push：领先落后探针（+ deep 的 ls-remote 远端真身比对） */
  private async verifySync(root: string, kind: 'pull' | 'push', depth: VerifyDepth): Promise<VerifyResult> {
    const branch = await this.currentBranch(root);
    if (!branch) return { verdict: 'skip' };   // detached / 异常：无从核对上游
    const track = await this.trackOf(root, branch);
    const verdict = judgeByTrack(kind, track);
    if (depth !== 'deep' || !track.upstream) return { ...verdict, ref: track.upstream };
    // deep：远端真身比对（fetch 路径陈旧 / 并行推送检测；失败 fail-open）。
    // warn 与 unknown 均如实采纳——deep 开启即期望远端确认，确认不了不能谎报 pass
    const drift = await this.remoteDrift(root, kind, branch);
    if (drift) return drift;
    return { ...verdict, ref: track.upstream };
  }

  /** ls-remote 比对：远端引用与本地视角（pull=跟踪引用 / push=HEAD）不一致 → 警示 */
  private async remoteDrift(root: string, kind: 'pull' | 'push', branch: string): Promise<VerifyResult | undefined> {
    if (!BRANCH_RE.test(branch)) return undefined;
    const remote = await this.run(root, ['config', '--get', `branch.${branch}.remote`], 4000);
    const merge = await this.run(root, ['config', '--get', `branch.${branch}.merge`], 4000);
    const remoteName = remote.stdout.trim();
    const mergeRef = merge.stdout.trim();
    if (!remote.ok || !merge.ok || !remoteName || !mergeRef || !BRANCH_RE.test(remoteName) || !mergeRef.startsWith('refs/heads/')) return undefined;
    const ls = await this.run(root, ['ls-remote', remoteName, mergeRef], 8000);
    if (!ls.ok) return undefined;
    const remoteSha = ls.stdout.trim().split('\t')[0] || '';
    if (!/^[0-9a-f]{40}$/.test(remoteSha)) return undefined;   // 远端无此分支：视为不可判定
    const short = `${remoteName}/${mergeRef.slice('refs/heads/'.length)}`;
    if (kind === 'pull') {
      const local = await this.trackingSha(root, remoteName, mergeRef);
      if (local && local !== remoteSha) return { verdict: 'warn', reason: 'remoteDrift', ref: short };
      return undefined;
    }
    // push：远端应包含本地 HEAD。三段判定——相同即无漂移；远端 sha 本地可知则 merge-base
    // 判包含（不可包含=改写/推错 → warn）；本地不可知（并行推送且未 fetch，对象不在本地）
    // 无法判包含 → 诚实降级 unknown（不打扰，与 fail-open 哲学一致）
    const head = await this.headSha(root);
    if (remoteSha === head) return undefined;
    const known = await this.run(root, ['cat-file', '-e', remoteSha], 4000);
    if (!known.ok) return { verdict: 'unknown' };
    const anc = await this.run(root, ['merge-base', '--is-ancestor', head, remoteSha], 4000);
    if (!anc.ok) return { verdict: 'warn', reason: 'remoteDrift', ref: short };
    return undefined;
  }

  // ---------- 探针（execFile 数组参数，绝不经 shell） ----------

  private run(root: string, args: string[], timeoutMs: number): Promise<{ stdout: string; ok: boolean }> {
    return new Promise(resolve => {
      execFile(this.executor.path, ['-c', 'core.quotepath=false', ...args], {
        cwd: root, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
      }, (err, stdout) => resolve({ stdout: String(stdout ?? ''), ok: !err }));
    });
  }

  private async headSha(root: string): Promise<string> {
    const r = await this.run(root, ['rev-parse', 'HEAD'], 4000);
    if (!r.ok) throw new Error('rev-parse HEAD failed');
    return r.stdout.trim();
  }

  /** 解析任意 ref 到 sha（checkout/reset 的预期值） */
  private async revSha(root: string, ref: string): Promise<string | undefined> {
    if (!BRANCH_RE.test(ref) && !/^[0-9a-f]{5,40}$/.test(ref)) return undefined;
    const r = await this.run(root, ['rev-parse', ref + '^{commit}'], 4000);
    return r.ok ? r.stdout.trim() : undefined;
  }

  private async currentBranch(root: string): Promise<string | undefined> {
    const r = await this.run(root, ['symbolic-ref', '--quiet', 'HEAD'], 4000);
    if (!r.ok) return undefined;   // detached
    const full = r.stdout.trim();
    return full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : undefined;
  }

  /** 本地分支的领先落后 + 上游短名（for-each-ref 全量输出后 JS 侧过滤，参数全字面量） */
  private async trackOf(root: string, branch: string): Promise<{ ahead: number; behind: number; upstream?: string }> {
    const r = await this.run(root, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)', 'refs/heads'], 5000);
    if (!r.ok) return { ahead: 0, behind: 0 };
    for (const line of r.stdout.split('\n')) {
      const f = line.split('\t');
      if (f[0] === branch) {
        return { ...parseTrack(f[2] ?? ''), upstream: f[1] || undefined };
      }
    }
    return { ahead: 0, behind: 0 };   // 分支不在列表（刚删除等）：无上游视角
  }

  private async trackingSha(root: string, remoteName: string, mergeRef: string): Promise<string | undefined> {
    const short = `refs/remotes/${remoteName}/${mergeRef.slice('refs/heads/'.length)}`;
    const r = await this.run(root, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/remotes'], 5000);
    if (!r.ok) return undefined;
    for (const line of r.stdout.split('\n')) {
      const f = line.split('\t');
      if (f[0] === short) return f[1];
    }
    return undefined;
  }

  private async tagExists(root: string, name: string): Promise<boolean> {
    const r = await this.run(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`], 4000);
    return r.ok;
  }
}
