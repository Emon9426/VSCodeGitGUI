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
  /** 变更文件目录树（路径级上下文；成功路径也附带，给模型目录视角） */
  fileTree?: string;
  /** diff 内容是否可用于推断（false = 差异过大/超时/全是省略标记，须以路径与目录结构推断） */
  diffUsable?: boolean;
}

function langName(lang: CommitPromptCtx['language'], subjects: string[]): string {
  if (lang === 'en') return 'English';
  if (lang === 'zh-cn') return 'Simplified Chinese';
  // auto：近期提交中文占比 ≥ 1/3 则中文，否则英文
  const zh = subjects.filter(s => /[\u4e00-\u9fff]/.test(s)).length;
  return subjects.length && zh * 3 >= subjects.length ? 'Simplified Chinese' : 'English';
}

export function buildSystemPrompt(ctx: CommitPromptCtx): string {
  const rules = [
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
  ];
  if (ctx.diffUsable === false) {
    rules.push(
      '7. Diff CONTENT is unavailable (oversized or binary files). Infer the change intent',
      '   from file paths, folder structure and file types; describe scope honestly',
      '   (e.g. "update build outputs") and never invent specific code details.',
    );
  }
  return rules.join('\n');
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
  if (ctx.diffUsable === false) {
    // 路径级降级：文件清单 + 目录树即全部事实来源（无差异内容）
    if (ctx.stagedSummary) {
      parts.push('# Changed files (status\tpath — no counts available)\n' + ctx.stagedSummary);
    }
    if (ctx.fileTree) {
      parts.push('# Changed-file tree (infer intent from paths, folders and file types)\n' + ctx.fileTree);
    }
    parts.push('Diff content is unavailable (files too large or binary). Write the commit message from the file list and tree above.');
    return parts.join('\n\n');
  }
  if (ctx.stagedSummary) {
    parts.push('# Staged changes summary\n' + ctx.stagedSummary);
  }
  if (ctx.fileTree) {
    parts.push('# Changed-file tree (folder-level view of the same changes)\n' + ctx.fileTree);
  }
  parts.push('# Staged diff (truncated to fit)\n' + (ctx.stagedDiff || '(no staged changes — summary only)'));
  parts.push('Write the commit message.');
  return parts.join('\n\n');
}
