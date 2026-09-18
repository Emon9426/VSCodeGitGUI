/**
 * push 失败分诊（纯函数，单测见 test/unit/pushTriage.test.ts）：
 *
 * 「拉取合并后再推送」建议只对「远端领先 / 非快进」类拒绝成立——客户端拒绝行的
 * (fetch first)/(non-fast-forward)，或 --force-with-lease 失效（stale info）时 hint 的
 * "branch is behind"。
 *
 * 服务端拒绝（! [remote rejected] (pre-receive hook declined)：大文件 GH001、受保护分支、
 * 部署策略等）同样以 "rejected" 与 "failed to push some refs" 收尾，但真实原因在
 * remote: error 行里——归因为 non-fast-forward 会诱导用户拉取后重推死循环且永远看不到
 * 真实原因（旧宽正则 /non-fast-forward|fetch first|rejected|failed to push/ 的病灶）。
 */

/** 远端领先/非快进的标志文本（判定时应先剔除 remote: 行，见 pushNeedsPull） */
export const PUSH_NEEDS_PULL_RE = /non-fast-forward|fetch first|branch is behind/i;

/** push 失败输出是否属于「远端领先/非快进」（对症建议：先拉取合并） */
export function pushNeedsPull(outputTail: string): boolean {
  // remote: 前缀行是服务端附言——个别服务端 hook 文案里也含 "non-fast-forward" 字样，
  // 但其语义是 pre-receive 拒绝而非本地落后，不参与判定
  const lines = outputTail.split('\n').filter(l => !l.trim().startsWith('remote:'));
  return PUSH_NEEDS_PULL_RE.test(lines.join('\n'));
}

/**
 * 从失败输出尾部提取人话错误行（错误通知正文首层；完整输出仍走折叠详情）：
 * 服务端拒绝优先——remote: error: 行去前缀（大文件类逐文件一行，取前 3 条）；
 * 其次末尾的 error:/fatal: 行（本地拒绝、认证失败等，取后 3 条）。
 */
export function gitErrorHint(outputTail: string): string | undefined {
  const lines = outputTail.split('\n').map(l => l.trim());
  const remote = lines
    .filter(l => /^remote:\s*error:/i.test(l))
    .map(l => l.replace(/^remote:\s*error:\s*/i, ''));
  if (remote.length) return remote.slice(0, 3).join('\n');
  const local = lines
    .filter(l => /^(?:error|fatal):/i.test(l))
    .map(l => l.replace(/^(?:error|fatal):\s*/i, ''));
  return local.length ? local.slice(-3).join('\n') : undefined;
}
