import { describe, expect, it } from 'vitest';
import { buildCreatePrUrl, parseRemoteUrl } from '../../src/git/prurl';

describe('parseRemoteUrl', () => {
  it('GitHub https/ssh 归一', () => {
    expect(parseRemoteUrl('https://github.com/Emon9426/VSCodeGitGUI.git'))
      .toEqual({ platform: 'github', web: 'https://github.com/Emon9426/VSCodeGitGUI' });
    expect(parseRemoteUrl('git@github.com:Emon9426/VSCodeGitGUI.git'))
      .toEqual({ platform: 'github', web: 'https://github.com/Emon9426/VSCodeGitGUI' });
    expect(parseRemoteUrl('ssh://git@github.com:22/Emon9426/VSCodeGitGUI.git'))
      .toEqual({ platform: 'github', web: 'https://github.com/Emon9426/VSCodeGitGUI' });
  });
  it('Azure DevOps https 带凭据前缀 / ssh v3 补 _git', () => {
    expect(parseRemoteUrl('https://org@dev.azure.com/org/proj/_git/repo'))
      .toEqual({ platform: 'azure', web: 'https://dev.azure.com/org/proj/_git/repo' });
    expect(parseRemoteUrl('git@ssh.dev.azure.com:v3/org/proj/repo'))
      .toEqual({ platform: 'azure', web: 'https://dev.azure.com/org/proj/_git/repo' });
    expect(parseRemoteUrl('https://org.visualstudio.com/proj/_git/repo'))
      .toEqual({ platform: 'azure', web: 'https://org.visualstudio.com/proj/_git/repo' });
  });
  it('GitLab 公网与自托管', () => {
    expect(parseRemoteUrl('https://gitlab.com/g/sub/repo.git'))
      .toEqual({ platform: 'gitlab', web: 'https://gitlab.com/g/sub/repo' });
    expect(parseRemoteUrl('git@gitlab.corp.local:team/repo.git'))
      .toEqual({ platform: 'gitlab', web: 'https://gitlab.corp.local/team/repo' });
  });
  it('不识别返回 null（本地路径/空/未知 host）', () => {
    expect(parseRemoteUrl('C:/x/y')).toBeNull();
    expect(parseRemoteUrl('file:///srv/git/repo.git')).toBeNull();
    expect(parseRemoteUrl('https://bitbucket.org/team/repo.git')).toBeNull();
    expect(parseRemoteUrl('')).toBeNull();
  });
});

describe('buildCreatePrUrl', () => {
  it('GitHub：to 已知 compare 展开；to 未知省略 base', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'git@github.com:o/r.git', from: 'feat', to: 'main' }))
      .toBe('https://github.com/o/r/compare/main...feat?expand=1');
    expect(buildCreatePrUrl({ remoteUrl: 'git@github.com:o/r.git', from: 'feat', to: null }))
      .toBe('https://github.com/o/r/compare/feat?expand=1');
  });
  it('GitLab：source/target 分支参数', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'https://gitlab.com/o/r.git', from: 'feat', to: 'main' }))
      .toBe('https://gitlab.com/o/r/-/merge_requests/new?merge_request[source_branch]=feat&merge_request[target_branch]=main');
  });
  it('Azure：sourceRef/targetRef', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'https://org@dev.azure.com/org/p/_git/r', from: 'dev/26R1', to: 'main' }))
      .toBe('https://dev.azure.com/org/p/_git/r/pullrequestscreate?sourceRef=dev%2F26R1&targetRef=main');
  });
  it('自定义模板优先：{from}/{to} 替换；需 {to} 而未知时退回自动', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'https://x/y', from: 'f', to: 't', template: 'https://ex.com/pr?src={from}&dst={to}' }))
      .toBe('https://ex.com/pr?src=f&dst=t');
    expect(buildCreatePrUrl({ remoteUrl: 'git@github.com:o/r.git', from: 'f', to: null, template: 'https://ex.com/pr?src={from}&dst={to}' }))
      .toBe('https://github.com/o/r/compare/f?expand=1');
  });
  it('分支名编码（斜杠/中文）', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'git@github.com:o/r.git', from: 'feature/新分支', to: null }))
      .toBe(`https://github.com/o/r/compare/${encodeURIComponent('feature/新分支')}?expand=1`);
  });
  it('不识别平台且无模板 → null；无 from → null', () => {
    expect(buildCreatePrUrl({ remoteUrl: 'C:/x', from: 'f' })).toBeNull();
    expect(buildCreatePrUrl({ remoteUrl: 'git@github.com:o/r.git', from: '' })).toBeNull();
  });
});
