# GitBoard 仓库协作规则

本文件对本仓库的所有 AI 会话生效，规则强制执行。

## Issue 修复工作流（强制）

修复任何 GitHub Issue 必须使用 `scripts/issue-flow.sh`，完整规范见 `docs/issue-workflow.md`。要点：

1. **开始修复**：`scripts/issue-flow.sh start <N> [slug]`——由它创建/复用分支并挂 Issue 关联分支，禁止手工 `git checkout -b` 起分支。
2. **提交**：`scripts/issue-flow.sh commit "<type>: <中文描述>" [N ...]`——脚本自动附加 `Refs #N` footer。**commit message 中禁止使用 `Fixes/Closes/Resolves #N`**（关闭 Issue 只能由 PR body 触发），禁止裸 `git commit` 绕过 footer。
3. **提 PR**：`scripts/issue-flow.sh pr [标题]`——默认先跑 `npm run typecheck && npm run test`，全绿才允许建 PR（未经用户明示同意不得 `--skip-test`）。PR body 的 `Closes #N` 列表由脚本从分支 commit 的 Refs 自动汇总，一个 PR 含多个 Issue 时必须全部列出。
4. **合并**：`scripts/issue-flow.sh merge`——squash 合并、删分支、回 main；Issue 由 GitHub 在合并时自动关闭，禁止手工 `gh issue close`。
5. **多 Issue 单 PR**：用第一个 Issue 的分支承载全部提交，各 commit 的 `Refs` 指向各自 Issue。
6. **中文提交信息**；提交可能被 Mimosa 安全门禁拦截，按提示处理高危后重试，`--no-verify` 无效。

## 其他约定

- 与用户沟通、文档、提交信息均用简体中文。
- 打包用 `npm run package`（内含 `--allow-missing-repository`）；全局 vsce 已损坏勿用。
- 临时目录禁止用 Git Bash 的 `/tmp`（Node 不可见），用 `os.tmpdir()` 或 Windows 路径。
