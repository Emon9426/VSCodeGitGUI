/**
 * RPC 闸门命令分类（Issue #75）：git 无关命令集。
 *
 * onMessage 对请求做「仓库扫描完成前先 await ensureRepos()」的闸门保护，防止
 * service/runner 尚未就绪时报错；但其中一批命令与 git 完全无关（只读写 globalState /
 * fs / VS Code API / Copilot LM），不应被 git 探测 → 仓库发现 → 首仓库解析的长链
 * 阻塞——工程目录切换等功能在 git 解析进行中即须可用。
 *
 * 归类标准：不依赖 executor / service / runner / files / roots / currentRepoId /
 * lastState / commitCache。新增命令时按此标准审视；拿不准就不进来（多等无害，
 * 误进来会在服务未就绪时抛错）。
 */
export const GIT_FREE_CMDS: ReadonlySet<string> = new Set([
  // 工程切换（v0.11）：globalState + fs + openFolder / showOpenDialog
  'projects.add',
  'projects.rename',
  'projects.remove',
  'projects.pickFolder',
  'projects.open',
  // 界面偏好持久化（globalState only）
  'ui:saveColWidths',
  'ui:saveDetailPct',
  'ui:saveFilesLayout',
  'ui:saveSideCollapsed',
  'ui:saveBranchGroups',
  'ui:saveNotifyWidth',
  'ui:saveSideWidth',
  'work.saveLayout',
  // 纯 UI / 环境
  'ui:copy',
  'ui:openSettings',
  'ui:pickLanguage',
  'ui:setView',
  // 会话内数据（内存快照）
  'pullHistory',
  // Copilot LM 查询/取消（不碰 git）
  'work.aiModels',
  'work.aiCancel',
  'err.aiDiagnose',
  'err.aiDiagnoseCancel',
]);
