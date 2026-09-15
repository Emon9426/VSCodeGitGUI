/**
 * 创建 Pull Request 的 Web URL 生成（Issue #61）——纯函数，单测覆盖。
 *
 * from=来源分支（当前分支），to=目标分支（远端默认分支，探测失败可空——
 * GitHub compare 省略 base 即默认分支，GitLab/Azure 页内可选）。
 * 识别 GitHub / GitLab / Azure DevOps 三类 remote（https 与 ssh 形态）；
 * 自定义模板（占位 {from}/{to}）优先；无法识别且无模板返回 null（调用方回退提示）。
 */

export interface PrUrlInput {
  remoteUrl: string;        // git remote get-url 原始输出
  from: string;             // 来源分支（当前分支名）
  to?: string | null;       // 目标分支；未知为 null
  template?: string;        // 用户自定义模板（含 {to} 而 to 未知时不使用）
}

export interface ParsedRemote {
  platform: 'github' | 'gitlab' | 'azure';
  /** 仓库 Web 基址（无 .git 尾巴、可继续拼路径） */
  web: string;
}

/** remote URL → Web 基址与平台；不识别返回 null。ssh 形态统一归一到 https。 */
export function parseRemoteUrl(url: string): ParsedRemote | null {
  let u = url.trim();
  if (!u) return null;
  let host = '';
  let rest = '';
  if (u.startsWith('https://')) {
    u = u.slice('https://'.length);
    const slash0 = u.indexOf('/');
    const at = u.indexOf('@');
    if (at >= 0 && (slash0 < 0 || at < slash0)) u = u.slice(at + 1);   // user@host/path 凭据前缀剥离
    const slash = u.indexOf('/');
    if (slash <= 0) return null;
    host = u.slice(0, slash);
    rest = u.slice(slash + 1);
  } else if (u.startsWith('ssh://')) {
    u = u.slice('ssh://'.length);
    const at = u.lastIndexOf('@');
    if (at >= 0) u = u.slice(at + 1);
    const slash = u.indexOf('/');
    if (slash <= 0) return null;
    host = u.slice(0, slash);
    rest = u.slice(slash + 1);
    const colon = host.indexOf(':');           // ssh://git@host:22/o/r 端口剥离
    if (colon >= 0) host = host.slice(0, colon);
  } else {
    // scp 短形：git@host:path（无 scheme）
    const at = u.indexOf('@');
    const colon = u.indexOf(':');
    if (at < 0 || colon < 0 || at > colon) return null;
    host = u.slice(at + 1, colon);
    rest = u.slice(colon + 1);
  }
  while (rest.endsWith('.git')) rest = rest.slice(0, -4);
  while (rest.endsWith('/')) rest = rest.slice(0, -1);
  if (!rest) return null;

  if (host === 'github.com') {
    return { platform: 'github', web: `https://github.com/${rest}` };
  }
  // Azure DevOps：https 形态 dev.azure.com/org/proj/_git/repo（可能带 org@ 凭据前缀）；
  // ssh 形态 ssh.dev.azure.com:v3/org/proj/repo——PR 创建页需 /_git/ 仓库名段，缺失时补全
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com') {
    const p = rest.startsWith('v3/') ? rest.slice(3) : rest;
    const parts = p.split('/');
    if (parts.length < 2) return null;
    let webPath = p;
    if (!p.includes('/_git/') && parts.length >= 3) {
      webPath = `${parts[0]}/${parts[1]}/_git/${parts.slice(2).join('/')}`;
    }
    return { platform: 'azure', web: `https://dev.azure.com/${webPath}` };
  }
  // 旧式 Visual Studio Team Services：org.visualstudio.com/proj/_git/repo
  if (host.endsWith('.visualstudio.com')) {
    return { platform: 'azure', web: `https://${host}/${rest}` };
  }
  // GitLab：gitlab.com 与自托管（host 含 gitlab）；路径可含子组（a/b/r）
  if (host === 'gitlab.com' || host.includes('gitlab')) {
    return { platform: 'gitlab', web: `https://${host}/${rest}` };
  }
  return null;
}

/** 生成创建 PR/MR 的 URL；无法识别平台且无可用模板时返回 null */
export function buildCreatePrUrl(input: PrUrlInput): string | null {
  const { from, to, template } = input;
  if (!from) return null;
  // 自定义模板优先：占位 {from}/{to}；模板需要 {to} 而目标未知时退回自动检测
  if (template && template.includes('{from}')) {
    if (!template.includes('{to}') || to) {
      return template
        .split('{from}').join(encodeURIComponent(from))
        .split('{to}').join(to ? encodeURIComponent(to) : '');
    }
  }
  const parsed = parseRemoteUrl(input.remoteUrl);
  if (!parsed) return null;
  const f = encodeURIComponent(from);
  const t = to ? encodeURIComponent(to) : null;
  switch (parsed.platform) {
    case 'github':
      // compare 省略 base = 默认分支为目标
      return t
        ? `${parsed.web}/compare/${t}...${f}?expand=1`
        : `${parsed.web}/compare/${f}?expand=1`;
    case 'gitlab':
      return t
        ? `${parsed.web}/-/merge_requests/new?merge_request[source_branch]=${f}&merge_request[target_branch]=${t}`
        : `${parsed.web}/-/merge_requests/new?merge_request[source_branch]=${f}`;
    case 'azure':
      return t
        ? `${parsed.web}/pullrequestscreate?sourceRef=${f}&targetRef=${t}`
        : `${parsed.web}/pullrequestscreate?sourceRef=${f}`;
  }
}
