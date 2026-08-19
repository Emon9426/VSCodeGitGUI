# GitGraph — VS Code Git 可视化插件

以图形化方式浏览与操作 Git 仓库的 VS Code 插件，界面布局参考 SourceTree。

## 功能（P0 已实现）

- 图形化提交历史：彩色拓扑图（分支/合并/交叉/多根）、ref 徽标（HEAD/分支/远程/标签）
- 提交列表：图形 | 说明 | 作者 | 短 SHA | 时间（YYYY-MM-DD HH:mm:ss）
- 提交详情：完整 SHA、作者/提交者、完整注释、变更文件（状态/±行数）；打开文件、查看历史版本（只读）、在文件管理器中定位
- 差异：面板内联 diff + 双击打开 VS Code 内置差异编辑器
- GUI 操作：Fetch（含 --all --prune）/ Pull（merge/rebase/ff-only）/ Push（含设置上游）/ 重置到提交（soft/mixed/hard，hard 强确认）/ 切换分支 / 检出远程分支为本地跟踪分支 / 分离 HEAD
- 大仓库性能：分页加载（500/页，自动上限可配）、虚拟滚动、Canvas 分层绘制、.git 监视防抖自动刷新
- 中英双语界面（跟随 VS Code 语言）

## 设计文档

`GitGraph-设计方案.html`（仓库根目录，浏览器打开阅读）—— 需求、架构、协议、算法、测试与里程碑。

## 开发

```bash
npm install        # 安装依赖
npm run watch      # esbuild 增量构建（F5 调试前置任务）
npm run typecheck  # 双工程类型检查（扩展宿主 / Webview）
npm test           # 单元测试 + 真实 git 冒烟测试（冒烟需 GITGRAPH_SMOKE=1）
npm run build      # 产出 out/extension.js + out/webview.js
npm run package    # vsce 打包 .vsix（需 npx @vscode/vsce）
```

调试：VS Code 中按 **F5**（"运行 GitGraph 扩展"）打开扩展开发宿主窗口，`Ctrl+Alt+G` 或命令面板 `GitGraph: 打开提交图`。

## 运行环境

| 依赖 | 最低版本 | 说明 |
| --- | --- | --- |
| VS Code | 1.85（桌面版） | 不支持 vscode.dev（需本地 git） |
| Node.js | 18 | 仅开发期需要 |
| Git | 2.30 | 通过系统 git CLI 工作 |

## 目录速览

```
src/common/    数据模型 / 通信协议 / i18n（两侧共享）
src/git/       执行器 / 解析 / 仓库发现 / 服务 / .git 监视
src/ops/       操作队列（fetch/pull/push/reset/checkout）
src/webview/   面板生命周期 / 消息路由 / gitgraph: 差异文档提供者
src/graph/     lane 分配算法（纯函数）
src/ui/        Webview 前端（工具栏/侧栏/虚拟列表/Canvas/详情/浮层）
test/          vitest 单测 + 真实 git 冒烟
```
