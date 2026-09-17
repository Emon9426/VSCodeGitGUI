/**
 * pushTarget 单元测试（Issue #14）：上游存在时显式推 HEAD:<上游分支名>
 * （本地名≠上游名不再静默推到远端同名分支），无上游/畸形上游返回 undefined。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { S, pushTarget } from '../../src/ui/state';

const setHeadUpstream = (upstream?: string): void => {
  S.state = {
    branches: [
      { name: 'master', fullName: 'refs/heads/master', sha: 'a'.repeat(40), upstream, isHead: true },
    ],
  } as typeof S.state;
};

afterEach(() => { S.state = undefined; });

describe('pushTarget（Issue #14）', () => {
  it('无 state / 无上游 → undefined', () => {
    S.state = undefined;
    expect(pushTarget()).toBeUndefined();
    setHeadUpstream(undefined);
    expect(pushTarget()).toBeUndefined();
  });

  it('上游 origin/main → HEAD:main（本地名 master≠main 不再推错）', () => {
    setHeadUpstream('origin/main');
    expect(pushTarget()).toEqual({ remote: 'origin', branch: 'HEAD:main' });
  });

  it('嵌套分支名 feat/x 整体保留（远端名不含斜杠，首个斜杠前是远端）', () => {
    setHeadUpstream('upstream/feat/x');
    expect(pushTarget()).toEqual({ remote: 'upstream', branch: 'HEAD:feat/x' });
  });

  it('上游同名常规场景 origin/master → HEAD:master', () => {
    setHeadUpstream('origin/master');
    expect(pushTarget()).toEqual({ remote: 'origin', branch: 'HEAD:master' });
  });

  it('畸形上游（无斜杠/空段）→ undefined（fail-safe 走建上游流程）', () => {
    setHeadUpstream('origin/');
    expect(pushTarget()).toBeUndefined();
    setHeadUpstream('/main');
    expect(pushTarget()).toBeUndefined();
  });
});
