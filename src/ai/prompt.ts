/**
 * 提交信息生成提示词（设计方案 §5.7 / 附录 A，v1.3）。
 * 纯文本契约：首行 = subject（≤50），空行后 = body（72 列软换行）；
 * 语言跟随近期提交主体语言；存在 Conventional Commits 风格则沿用。
 * 工程指示文件（.copilot/ 与 .github/ 约定）以 MUST follow 小节注入。
 */

export interface CommitPromptCtx {
  stagedSummary: string;
  stagedDiff: string;
  recentSubjects: string[];
  instructions: { path: string; content: string }[];
  language: 'auto' | 'en' | 'zh-cn';
}

function langName(lang: CommitPromptCtx['language'], subjects: string[]): string {
  if (lang === 'en') return 'English';
  if (lang === 'zh-cn') return 'Simplified Chinese';
  // auto：近期提交中文占比 ≥ 1/3 则中文，否则英文
  const zh = subjects.filter(s => /[\u4e00-\u9fff]/.test(s)).length;
  return subjects.length && zh * 3 >= subjects.length ? 'Simplified Chinese' : 'English';
}

export function buildSystemPrompt(ctx: CommitPromptCtx): string {
  return [
    'You are an expert assistant that writes git commit messages.',
    'STRICT OUTPUT CONTRACT:',
    '1. Plain text only. First line = subject. Then ONE blank line. Then optional body.',
    '   No markdown, no code fences, no explanations outside the message.',
    '2. Subject: max 50 characters, imperative mood, no trailing period.',
    '3. Body: wrap at 72 characters; explain WHAT and WHY (motivation, impact),',
    '   never narrate the diff line by line. Omit the body if the change is trivial.',
    `4. Language: write in ${langName(ctx.language, ctx.recentSubjects)}.`,
    '5. If the recent commits follow Conventional Commits (feat|fix|docs|refactor|...),',
    '   reuse the same `type(scope): subject` pattern; otherwise do not invent one.',
    '6. If repository custom instructions are provided below, they take precedence.',
  ].join('\n');
}

export function buildUserPrompt(ctx: CommitPromptCtx): string {
  const parts: string[] = [];
  if (ctx.recentSubjects.length) {
    parts.push('# Recent commits (style reference, latest first)\n' + ctx.recentSubjects.map(s => '· ' + s).join('\n'));
  }
  if (ctx.instructions.length) {
    parts.push('# Repository custom instructions (MUST follow)\n'
      + ctx.instructions.map(i => `## from ${i.path}\n${i.content}`).join('\n\n'));
  }
  if (ctx.stagedSummary) {
    parts.push('# Staged changes summary\n' + ctx.stagedSummary);
  }
  parts.push('# Staged diff (truncated to fit)\n' + (ctx.stagedDiff || '(no staged changes — summary only)'));
  parts.push('Write the commit message.');
  return parts.join('\n\n');
}
