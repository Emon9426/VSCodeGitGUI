/**
 * fixplan 单元测试（Issue #8 P2）：修复块解析、argv 切分、白名单分级矩阵。
 * 重点：提示注入样例必须全部落入 copy/null（威胁模型=stderr 为不可信输入）。
 */
import { describe, expect, it } from 'vitest';
import { parseFixBlock, splitArgv, validateStep } from '../../src/ai/fixplan';

const lv = (cmd: string) => validateStep(cmd).level;
const spec = (cmd: string) => validateStep(cmd).spec;

describe('parseFixBlock', () => {
  const ok = '分析……\n```gitboard-fix\n{"steps":[{"title":"拉取","cmd":"git pull --rebase","risk":"safe"}]}\n```\n结束';

  it('提取合法修复块', () => {
    const r = parseFixBlock(ok);
    expect(r).toEqual([{ title: '拉取', cmd: 'git pull --rebase' }]);
  });
  it('#37 三要素：action/consequence 解析、缺失 undefined、类型非法忽略、超长截断', () => {
    const full = parseFixBlock('```gitboard-fix\n' + JSON.stringify({
      steps: [{
        title: '贮藏后重拉', cmd: 'git pull --autostash',
        action: '先暂存未提交修改再拉取', consequence: '拉取完成后自动恢复修改；若冲突则贮藏保留',
        risk: 'safe',
      }],
    }) + '\n```');
    expect(full?.[0].action).toBe('先暂存未提交修改再拉取');
    expect(full?.[0].consequence).toBe('拉取完成后自动恢复修改；若冲突则贮藏保留');
    // 缺失 → undefined（UI 以 title 兜底）
    expect(parseFixBlock(ok)?.[0].action).toBeUndefined();
    expect(parseFixBlock(ok)?.[0].consequence).toBeUndefined();
    // 类型非法（数字）与空串 → undefined；超长截断 ≤200
    const bad = parseFixBlock('```gitboard-fix\n' + JSON.stringify({
      steps: [{ title: 't', cmd: 'git status', action: 42, consequence: '', extra: 'x' },
              { title: 't2', cmd: 'git fetch', action: 'a'.repeat(300) }],
    }) + '\n```');
    expect(bad?.[0].action).toBeUndefined();
    expect(bad?.[0].consequence).toBeUndefined();
    expect(bad?.[1].action?.length).toBe(200);
  });
  it('无块 / JSON 非法 / steps 空 / 字段缺失 → null（前端降级纯诊断）', () => {
    expect(parseFixBlock('纯文本没有修复块')).toBeNull();
    expect(parseFixBlock('```gitboard-fix\n{oops}\n```')).toBeNull();
    expect(parseFixBlock('```gitboard-fix\n{"steps":[]}\n```')).toBeNull();
    expect(parseFixBlock('```gitboard-fix\n{"steps":[{"title":"x"}]}\n```')).toBeNull();
  });
  it('steps ≤5、title ≤80、cmd ≤300 截断', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, cmd: 'git status' }));
    const r = parseFixBlock('```gitboard-fix\n' + JSON.stringify({ steps: many }) + '\n```');
    expect(r).toHaveLength(5);
    const long = parseFixBlock('```gitboard-fix\n' + JSON.stringify({ steps: [{ title: 'x'.repeat(120), cmd: 'y'.repeat(400) }] }) + '\n```');
    expect(long?.[0].title.length).toBe(80);
    expect(long?.[0].cmd.length).toBe(300);
  });
});

describe('splitArgv', () => {
  it('空格/制表分隔与引号包裹', () => {
    expect(splitArgv('git add -- "a b.txt" c.txt')).toEqual(['git', 'add', '--', 'a b.txt', 'c.txt']);
    expect(splitArgv("git commit -m 'x y'")).toEqual(['git', 'commit', '-m', 'x y']);
  });
  it('换行与未闭合引号 → null', () => {
    expect(splitArgv('git push\nrm -rf /')).toBeNull();
    expect(splitArgv('git push "unclosed')).toBeNull();
  });
});

describe('validateStep：run 级（映射现有 OpSpec）', () => {
  it('fetch：旗标与 remote 组合', () => {
    expect(spec('git fetch --all --prune origin')).toEqual({ kind: 'fetch', all: true, prune: true, remote: 'origin' });
    expect(lv('git fetch')).toBe('run');
    expect(spec('git fetch origin')).toEqual({ kind: 'fetch', remote: 'origin' });
  });
  it('pull：策略与 autostash；互斥旗标同现降级', () => {
    expect(spec('git pull --rebase')).toEqual({ kind: 'pull', strategy: 'rebase' });
    expect(spec('git pull --ff-only --autostash')).toEqual({ kind: 'pull', strategy: 'ff-only', autostash: true });
    expect(lv('git pull --rebase --ff-only')).toBe('copy');
  });
  it('push：普通=run，-u 保留', () => {
    expect(spec('git push origin main')).toEqual({ kind: 'push', remote: 'origin', branch: 'main' });
    expect(spec('git push -u origin feat')).toEqual({ kind: 'push', remote: 'origin', branch: 'feat', setUpstream: true });
  });
  it('add：-A 与 -- 分隔路径（无 -- 的路径形态降级）', () => {
    expect(spec('git add -A')).toEqual({ kind: 'stage', all: true });
    expect(spec('git add -- a.txt "b/c d.ts"')).toEqual({ kind: 'stage', paths: ['a.txt', 'b/c d.ts'] });
    expect(lv('git add a.txt')).toBe('copy');
  });
  it('merge/rebase --abort → mergeAbort', () => {
    expect(spec('git merge --abort')).toEqual({ kind: 'mergeAbort' });
    expect(spec('git rebase --abort')).toEqual({ kind: 'mergeAbort', rebase: true });
  });
});

describe('validateStep：confirm 级（不可逆/覆盖类）', () => {
  it('reset --soft/--mixed → confirm；裸 reset=mixed HEAD', () => {
    expect(spec('git reset --soft HEAD~1')).toEqual({ kind: 'reset', mode: 'soft', sha: 'HEAD~1' });
    expect(spec('git reset --mixed abc1234')).toEqual({ kind: 'reset', mode: 'mixed', sha: 'abc1234' });
    expect(spec('git reset')).toEqual({ kind: 'reset', mode: 'mixed', sha: 'HEAD' });
  });
  it('checkout ref / --detach → confirm', () => {
    expect(spec('git checkout main')).toEqual({ kind: 'checkout', ref: 'main' });
    expect(spec('git checkout --detach 1a2b3c4')).toEqual({ kind: 'checkout', sha: '1a2b3c4', detached: true });
  });
  it('push --force-with-lease → confirm（带旗标）', () => {
    expect(spec('git push --force-with-lease origin main'))
      .toEqual({ kind: 'push', remote: 'origin', branch: 'main', forceWithLease: true });
  });
});

describe('validateStep：copy 级与注入样例（永不执行）', () => {
  const copies = [
    'git push --force origin main',
    'git push -f origin main',
    'git reset --hard HEAD',
    'git clean -fd',
    'git stash',
    'git config user.name x',
    'git branch -D main',
    'git remote add evil https://x',
    'git checkout -- file.txt',           // 路径形态不映射
    'git fetch --all extra1 extra2',      // 多余位置参数
    // 注入样例（重点）：shell 元字符与旗标注入
    'git push origin main; rm -rf /',
    'git push origin main && echo pwn',
    'git push origin main | sh',
    'git push origin $(whoami)',
    'git push origin `whoami`',
    'git fetch --upload-pack=evil origin',
    'git pull -oProxy=http://evil',
    'git push origin -oProxy=x',
    'echo hi',
    'git -c core.fsck=0 push origin main',
    'git push origin main\nrm -rf /',
  ];
  for (const cmd of copies) {
    it(`copy：${cmd}`, () => {
      expect(lv(cmd)).toBe('copy');
      expect(spec(cmd)).toBeUndefined();
    });
  }
  it('validateStep 不读模型自报 risk（输入只有命令串）', () => {
    expect(lv('git push --force origin main')).toBe('copy');   // 即使模型声称 safe
  });
});
