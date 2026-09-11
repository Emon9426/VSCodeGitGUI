/**
 * AI 错误诊断（Issue #8）：脱敏 + 提示词。
 *
 * 威胁模型：stderr 是不可信输入（远端回显可控），提示注入可诱导模型
 * 产出恶意"修复"命令——因此①发送前强制 maskSecrets 掩码 URL 凭证；
 * ②修复命令的放行与否由本地 fixplan.validateStep 独立判定，模型自报
 * risk 仅作展示。本模块只负责"把错误讲清楚"，不负责"判定能否执行"。
 */

/** URL 凭证脱敏：user:pass@ 与 token@ 两种形态 → ***@（网络错误回显 remote URL 是常态） */
export function maskSecrets(text: string): string {
  return text
    .replace(/(https?:\/\/|ssh:\/\/|git:\/\/)[^\s/:@]+:[^@\s/]+@/g, '$1***@')
    .replace(/(https?:\/\/|ssh:\/\/|git:\/\/)[^@\s/]+@/g, '$1***@');
}

export interface DiagnoseCtx {
  /** 操作名（已本地化，如「推送」） */
  op: string;
  /** git 命令行（调用方保证已 maskSecrets） */
  command?: string;
  exitCode?: number;
  /** 人话失败原因（已本地化，如「推送到 origin 时出错」） */
  message?: string;
  /** stderr 尾部（调用方保证已 maskSecrets + 截断） */
  outputTail?: string;
  /** 仓库状态单行摘要（如 "main → origin/main (ahead 2, behind 1)"，宿主拼装） */
  repo?: string;
  language: 'auto' | 'en' | 'zh-cn';
  /** 诊断生效语言名（auto 已由宿主解析为 English/Simplified Chinese） */
  langName: string;
}

/**
 * 诊断提示词（单条 user 消息，与提交信息生成同形态）。
 * 输出契约：三段式分析 + 机器可读 gitboard-fix 块（P2 修复方案的数据源）。
 */
export function buildDiagnosePrompt(ctx: DiagnoseCtx): string {
  const parts: string[] = [];
  parts.push(
    'You are an expert assistant that diagnoses failed git operations.',
    'OUTPUT CONTRACT (strict):',
    '1. Write exactly these sections in order, each starting with "## ":',
    '   "## Root cause" (one or two sentences), "## Fix steps" (numbered steps;',
    '   include exact git commands in inline code), then optionally "## Prevention".',
    `2. Write everything in ${ctx.langName}.`,
    '3. Never invent facts absent from the error output. If you infer from the exit',
    '   code or command alone, say so explicitly. If the error indicates an',
    '   environment problem (network, credentials, quota), state that instead of',
    '   guessing a repository-side cause.',
    '4. After the sections, output a fenced code block ```gitboard-fix containing',
    '   ONLY a JSON object: {"steps":[{"title":"short step title","cmd":"git ...",',
    '   "action":"what this command does (one short sentence)",',
    '   "consequence":"what happens to the repo after running it, incl. reversibility",',
    '   "risk":"safe|caution"}]}',
    '   - At most 5 steps, ordered; each cmd is ONE git command line.',
    '   - No shell operators (&&, ||, |, ;, >, <, backticks, $()) inside cmd.',
    '   - When staging specific paths, write `git add -- <paths>`.',
    '   - Prefer minimal commands that directly resolve the root cause.',
    '   - action/consequence are user-facing plain language (no jargon); they are',
    '     display-only — the app independently validates every command.',
    '   - "risk" is your own hint only; it never affects execution.',
    '5. If no safe command-based fix exists (e.g. requires editing files or human',
    '   decisions), omit the gitboard-fix block entirely.',
  );
  parts.push(`# Failed operation\n${ctx.op}${ctx.message ? ` — ${ctx.message}` : ''}`);
  if (ctx.command) parts.push(`# Command\n${ctx.command}`);
  if (typeof ctx.exitCode === 'number') parts.push(`# Exit code\n${ctx.exitCode}`);
  if (ctx.repo) parts.push(`# Repository state\n${ctx.repo}`);
  parts.push(`# Error output (tail; credentials masked)\n${ctx.outputTail ?? '(empty)'}`);
  parts.push('Diagnose the failure and provide the fix.');
  return parts.join('\n\n');
}
