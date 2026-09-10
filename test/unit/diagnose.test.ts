/**
 * diagnose 单元测试（Issue #8）：URL 凭证脱敏与提示词契约。
 */
import { describe, expect, it } from 'vitest';
import { buildDiagnosePrompt, maskSecrets } from '../../src/ai/diagnose';

describe('maskSecrets（发送前硬性脱敏）', () => {
  it('user:pass@ 与 token@ 两种形态 → ***@', () => {
    expect(maskSecrets('https://user:pass@github.com/o/r.git')).toBe('https://***@github.com/o/r.git');
    expect(maskSecrets('https://ghp_token123@github.com/o/r.git')).toBe('https://***@github.com/o/r.git');
    expect(maskSecrets('ssh://user:secret@host/repo')).toBe('ssh://***@host/repo');
  });
  it('无凭证 URL 与 scp 形态不受影响', () => {
    expect(maskSecrets('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(maskSecrets('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
  });
  it('多行 stderr 混合场景逐处掩码', () => {
    const out = maskSecrets('remote: E https://alice:secret@github.com/o/r.git\n ! [rejected] main -> main\nfatal: Authentication failed for https://tok1@github.com/o/r.git/');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('tok1');
    expect(out).toContain('! [rejected] main -> main');
    expect(out.match(/\*\*\*@/g)?.length).toBe(2);
  });
});

describe('buildDiagnosePrompt（输出契约）', () => {
  const prompt = buildDiagnosePrompt({
    op: '推送',
    command: 'git push --progress origin main',
    exitCode: 1,
    message: '推送到 origin 时出错',
    outputTail: '! [rejected] main -> main (non-fast-forward)',
    repo: 'main → origin/main (behind 2)',
    language: 'zh-cn',
    langName: 'Simplified Chinese',
  });

  it('三段式契约与修复块契约在场', () => {
    expect(prompt).toContain('## Root cause');
    expect(prompt).toContain('## Fix steps');
    expect(prompt).toContain('gitboard-fix');
    expect(prompt).toContain('"steps"');
  });
  it('语言、禁止捏造、单命令约束在场', () => {
    expect(prompt).toContain('Simplified Chinese');
    expect(prompt).toContain('Never invent facts');
    expect(prompt).toContain('ONE git command line');
    expect(prompt).toContain('git add -- <paths>');
  });
  it('上下文注入：命令/退出码/仓库状态/错误输出', () => {
    expect(prompt).toContain('git push --progress origin main');
    expect(prompt).toContain('Exit code\n1');
    expect(prompt).toContain('main → origin/main (behind 2)');
    expect(prompt).toContain('non-fast-forward');
  });
});
