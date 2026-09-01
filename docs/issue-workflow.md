# GitBoard Issue 修复工作流

从 Issue 到合并的全流程规范。配套自动化：`scripts/issue-flow.sh`（依赖 `git` + `gh`）。

```
Issue ──► 分支 issue-N-slug ──► 逐个提交(Refs #N) ──► 测试全绿 ──► PR(Closes #N) ──► squash 合并
            gh issue develop      git commit            typecheck+test   gh pr create     GitHub 自动关闭 Issue
```

## 1. 分支

| 规则 | 说明 |
|---|---|
| 命名 | `issue-<N>-<slug>`，如 `issue-1-long-path-open-folder` |
| 来源 | 一律从 `main` 切出，通过 `gh issue develop` 创建（远端同步创建 + Issue 挂关联分支） |
| 一个 Issue 一个分支 | 分支与 Issue 一一对应；slug 用 Issue 标题的英文关键词，全中文标题可省略（仅 `issue-N`） |

## 2. Commit

每次提交的 message 末尾**必须**带 footer 记录归属 Issue：

```
<type>: <中文描述>

Refs #<N>
```

- `<type>` ∈ fix / feat / refactor / test / docs / chore
- **用 `Refs` 而非 `Fixes`/`Closes`**：commit 只负责记录归属，不触发关闭（closing keyword 写进 commit 会因 cherry-pick、变基等产生误关闭）；关闭 Issue 统一由 PR body 负责（见下）
- 一次提交涉及多个 Issue 时写多行：`Refs #1`、`Refs #2`
- 提交前本地测试通过是硬性门槛（`npm run typecheck && npm run test`）

## 3. Pull Request

- **标题**：单 Issue → `fix: #<N> <Issue标题>`；多 Issue → `fix: #<N1> #<N2> ...`
- **Body 必须列出全部修复的 Issue**（每行一条 closing keyword，合并进 `main` 时 GitHub 自动关闭）：

```markdown
## 关联 Issue

Closes #1 长路径下，打开文件夹不可用
Closes #2 快速笔记：右键在资源管理器中打开无效

## 验证

- [x] npm run typecheck
- [x] npm run test（118 个用例全绿）
```

- 一个 PR 包含多个 Issue 的做法：**用第一个 Issue 的分支作为 PR 分支**，后续 Issue 的修复提交直接堆在该分支上（commit footer 各自 `Refs` 对应 Issue）。Issue 页面的"关联分支"只挂主 Issue，其余 Issue 由 PR body 的 `Closes` 关闭，效果一致
- 测试通过后才允许建 PR（脚本默认强制执行）

## 4. 合并

- 一律 **squash merge**：`main` 上每个 PR 只留一个干净提交，PR 标题作为 commit 标题
- 合并后删除分支、切回 `main` 并拉取
- Issue 的关闭由 GitHub 在合并瞬间自动完成，无需手动 `gh issue close`

## 5. 命令速查

```bash
# 开始修复 Issue 3（创建分支+挂关联+切换）
scripts/issue-flow.sh start 3 quick-note-open-in-explorer

# 提交（Refs #3 自动附加；多 Issue 单 PR 时显式指定号）
scripts/issue-flow.sh commit "fix: 修复右键菜单定位"          # → Refs #3（取自分支名）
scripts/issue-flow.sh commit "fix: 统一路径处理逻辑" 3 4     # → Refs #3、Refs #4

# 测试通过后建 PR（自动跑 typecheck+test，自动扫描 Refs 生成 Closes 列表）
scripts/issue-flow.sh pr                       # 标题自动生成
scripts/issue-flow.sh pr "fix: 路径与资源管理器打开" --skip-test

# 合并（squash + 删分支 + 回 main）
scripts/issue-flow.sh merge
```

> 注：`git commit` 若被 Mimosa 安全门禁拦截，按其提示处理高危项后重试，`--no-verify` 无效。
