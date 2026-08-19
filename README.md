# GitGraph — VS Code Git 可视化插件

以图形化方式浏览与操作 Git 仓库的 VS Code 插件，界面布局参考 SourceTree。

## 当前状态：设计阶段

- **设计方案**：[GitGraph-设计方案.html](./GitGraph-设计方案.html)（用浏览器打开阅读，自带目录导航）
- 开发里程碑与验收标准见方案第 15 节

## 运行环境要求（规划）

| 依赖 | 最低版本 | 说明 |
| --- | --- | --- |
| VS Code | 1.85（桌面版） | 不支持 Web 版（vscode.dev），因为需要执行本地 git 命令 |
| Node.js | 18 | 仅开发期需要 |
| Git | 2.30 | 插件通过调用系统 `git` CLI 工作 |
