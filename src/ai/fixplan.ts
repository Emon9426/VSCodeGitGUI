/**
 * AI 修复方案校验器（Issue #8 P2）——纯函数、无 IO，可穷举单测。
 *
 * 安全模型（提示注入防线）：诊断文本由不可信 stderr 影响，模型产出的
 * "修复命令"一律视为不可信输入。本模块对每条命令独立分级：
 *   run     = 白名单低危子集，映射到现有 OpSpec，可直接执行
 *   confirm = 不可逆/覆盖类，前端执行前逐条 S6 危险确认
 *   copy    = 白名单外/高危/无法解析 → 仅提供复制，永不执行
 * 模型自报 risk 字段不参与判定。执行走 execFile 参数数组（executor 既有
 * 保证，绝不经 shell），此处对 shell 元字符再做防御性双写。
 */
import type { OpSpec, PullStrategy, ResetMode } from '../ops/runner';

export type FixLevel = 'run' | 'confirm' | 'copy';

export interface FixStepRaw {
  title: string;
  cmd: string;
}

export interface ValidatedStep {
  level: FixLevel;
  /** run/confirm 级映射的 OpSpec（copy 级无） */
  spec?: OpSpec;
}

/** 引号感知 argv 切分（"..."与'...'，反斜杠按字面）；换行/畸形引号 → null */
export function splitArgv(cmd: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (c === '\n' || c === '\r') return null;
    if (c === '"' || c === "'") {
      const close = cmd.indexOf(c, i + 1);
      if (close < 0) return null;   // 未闭合
      cur += cmd.slice(i + 1, close);
      started = true;
      i = close + 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started || cur) { out.push(cur); cur = ''; started = false; }
      i++;
      continue;
    }
    cur += c;
    started = true;
    i++;
  }
  if (started || cur) out.push(cur);
  return out;
}

/**
 * 从诊断全文提取 ```gitboard-fix JSON 块（首个）；无块/解析失败/结构非法 → null
 * （前端降级为纯诊断）。约束：steps ≤5、title ≤80、cmd ≤300，超限截断。
 */
export function parseFixBlock(text: string): FixStepRaw[] | null {
  const m = text.match(/```gitboard-fix\s*\n([\s\S]*?)```/);
  if (!m) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const steps = (parsed as any)?.steps;
  if (!Array.isArray(steps) || !steps.length) return null;
  const out: FixStepRaw[] = [];
  for (const s of steps.slice(0, 5)) {
    const title = typeof s?.title === 'string' ? s.title.trim().slice(0, 80) : '';
    const cmd = typeof s?.cmd === 'string' ? s.cmd.trim().slice(0, 300) : '';
    if (!title || !cmd) return null;   // 结构非法整体作废（宁缺毋滥）
    out.push({ title, cmd });
  }
  return out;
}

// ---------- 白名单工具 ----------

const COPY: ValidatedStep = { level: 'copy' };
const SHELL_META = /[;&|<>`$\\]/;
/** ref/remote/branch/sha 位置参数：禁止以 - 开头（防旗标注入）、禁 .. 区间、长度 ≤120 */
const REF_RE = /^(?!-)[A-Za-z0-9._/@+~^]{1,120}$/;
/** add 的路径参数：不以 - 开头，长度 ≤200（引号包裹的空格已由 splitArgv 归一为单 token） */
const PATH_RE = /^(?!-)[^;&|<>`$\\]{1,200}$/;

const isRef = (s: string): boolean => REF_RE.test(s) && !s.includes('..');

/** 本地独立分级：argv[0] 必须 git；子命令 + 旗标逐项枚举，未知即降级 copy */
export function validateStep(cmd: string): ValidatedStep {
  if (SHELL_META.test(cmd)) return COPY;
  const argv = splitArgv(cmd);
  if (!argv || argv.length < 2 || argv[0] !== 'git') return COPY;
  const args = argv.slice(1);
  if (args[0].startsWith('-')) return COPY;   // 不放行任何全局选项（-c/-C/--no-pager…）
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'fetch': {
        const spec: OpSpec = { kind: 'fetch' };
        for (const a of rest) {
          if (a === '--all') spec.all = true;
          else if (a === '--prune') spec.prune = true;
          else if (a === '--progress') { /* 进度旗标，忽略 */ }
          else if (!spec.remote && isRef(a)) spec.remote = a;
          else return COPY;
        }
        return { level: 'run', spec };
      }
      case 'pull': {
        const spec: OpSpec = { kind: 'pull' };
        let rebase = false;
        let ffOnly = false;
        for (const a of rest) {
          if (a === '--rebase') rebase = true;
          else if (a === '--ff-only') ffOnly = true;
          else if (a === '--autostash') spec.autostash = true;
          else if (a === '--progress') { /* 进度旗标，忽略 */ }
          else return COPY;
        }
        if (rebase && ffOnly) return COPY;   // 互斥旗标同现
        spec.strategy = (rebase ? 'rebase' : ffOnly ? 'ff-only' : undefined) as PullStrategy | undefined;
        return { level: 'run', spec };
      }
      case 'push': {
        const spec: OpSpec = { kind: 'push' };
        let forceLease = false;
        const pos: string[] = [];
        for (const a of rest) {
          if (a === '--progress') continue;
          if (a === '-u' || a === '--set-upstream') spec.setUpstream = true;
          else if (a === '--force-with-lease') forceLease = true;
          else if (/^--force/.test(a) || a === '-f') return COPY;   // --force 全家族禁执行
          else if (isRef(a)) pos.push(a);
          else return COPY;
        }
        if (pos.length > 2) return COPY;
        spec.remote = pos[0];
        spec.branch = pos[1];
        spec.forceWithLease = forceLease || undefined;
        // force-with-lease 覆盖远端历史 → confirm；普通推送 run
        return forceLease ? { level: 'confirm', spec } : { level: 'run', spec };
      }
      case 'add': {
        if (rest.length === 1 && (rest[0] === '-A' || rest[0] === '--all')) {
          return { level: 'run', spec: { kind: 'stage', all: true } };
        }
        const paths: string[] = [];
        let afterSep = false;
        for (const a of rest) {
          if (a === '--') { afterSep = true; continue; }
          if (!PATH_RE.test(a)) return COPY;
          paths.push(a);
        }
        if (!afterSep || !paths.length || paths.length > 50) return COPY;   // 路径必须以 -- 分隔
        return { level: 'run', spec: { kind: 'stage', paths } };
      }
      case 'merge':
      case 'rebase':
        if (rest.length === 1 && rest[0] === '--abort') {
          return { level: 'run', spec: { kind: 'mergeAbort', rebase: sub === 'rebase' || undefined } };
        }
        return COPY;
      case 'reset': {
        let mode: ResetMode | undefined;
        let sha: string | undefined;
        for (const a of rest) {
          if (a === '--soft') mode = 'soft';
          else if (a === '--mixed') mode = 'mixed';
          else if (a === '--hard') return COPY;   // 丢弃工作副本：永不自动执行
          else if (isRef(a) && !sha) sha = a;
          else return COPY;
        }
        if (!mode) mode = 'mixed';   // 裸 reset = mixed
        return { level: 'confirm', spec: { kind: 'reset', mode, sha: sha ?? 'HEAD' } };
      }
      case 'checkout': {
        let detach = false;
        const pos: string[] = [];
        for (const a of rest) {
          if (a === '--detach') detach = true;
          else if (isRef(a)) pos.push(a);
          else return COPY;   // checkout -- <paths> 等形态不映射（restore 语义不同）
        }
        if (pos.length !== 1) return COPY;
        const ref = pos[0];
        return {
          level: 'confirm',
          spec: detach
            ? { kind: 'checkout', sha: ref, detached: true }
            : { kind: 'checkout', ref },
        };
      }
      default:
        return COPY;
    }
  } catch {
    return COPY;
  }
}
