# GitBoard — Git 可视化提交图 / Git Commit Graph for VS Code

**简体中文** | [English](#english-documentation)

GitBoard 是一个 VS Code 桌面版插件，以 SourceTree 风格的图形化提交历史为核心，浏览与操作 Git 仓库：彩色拓扑提交图、提交详情与差异对比、以及 Fetch / Pull / Push / 重置 / 切换分支等日常 GUI 操作。针对大仓库做了分页加载、虚拟滚动与分层渲染优化。**v0.7.0 新增「工作副本」提交视图**：SourceTree 式勾选暂存与提交（单文件差异、提交/推送/修订上次提交），并接入 GitHub Copilot 一键生成提交信息（流式填充，自动遵循工程 `.copilot/` 指示文件）。

GitBoard is a VS Code extension (desktop) that visualizes and operates Git repositories with a SourceTree-style commit graph: colored topology, commit details & diffs, plus everyday GUI operations (Fetch / Pull / Push / Reset / Checkout). Built for large repos with paging, virtualized scrolling and layered rendering. **New in v0.7.0 — the "Working Copy" commit view**: SourceTree-style checkbox staging and committing (single-file diff, commit / commit & push / amend), plus one-click AI commit messages via GitHub Copilot (streamed inline, automatically following workspace `.copilot/` instruction files).

![主界面总览 / Overview](res/overview.png)

---

## 中文文档

### 功能特性

| 特性 | 说明 |
| --- | --- |
| 图形化提交历史 | 彩色拓扑图呈现分支、合并、交叉与多根仓库；HEAD / 本地分支 / 远程分支 / 标签徽标；HEAD 节点以 SourceTree 式红色圆环标记，一眼定位当前提交（v0.13.0） |
| 提交详情 | 完整 SHA（一键复制）、作者/提交者、完整提交注释、变更文件列表（状态与 ± 行数）；文件 Ctrl/⌘ 累积多选、Shift 范围多选，文件头 ↗ 按钮或右键一次在编辑器打开多个文件（v0.11.0）；面板高度按百分比记忆，不同尺寸屏幕相对高度一致（v0.11.0）；diff 工具栏「在 VS Code 中打开」按钮直接打开工作区文件（v0.13.0） |
| 差异对比 | 面板内联 diff（紧凑模式只看增删行，`⋯` 折叠无差异段落）+ VS Code 内置差异编辑器（语法高亮） |
| 文件操作 | 打开工作区文件、查看任意历史版本（只读）、在系统文件管理器中定位（已删除文件自动回退父目录）、复制路径。长路径兼容（v0.13.2）：Windows 路径超过 259 字符时 explorer 命令行无法解析，自动降级定位到最深可用祖先目录并选中 |
| GUI Git 操作 | Fetch（--all --prune）、Pull（merge/rebase/ff-only）、Push（含设置上游）、重置到提交（soft/mixed/hard）、切换分支、检出远程分支、分离 HEAD；SourceTree 式后台自动获取（默认 10 分钟，`gitboard.autoFetchInterval` 可配可关，v0.13.0） |
| 文件历史页（v0.14.0） | 工具栏第四视图「🗂 文件」：左区资源管理器支持**文件夹视图（平铺）/ 详细信息视图**（名称/修改日期/类型/大小，每列可拖宽并记忆、目录优先、类型图标）与 **Win11 式地址栏**（面包屑 ⇄ 编辑态，粘贴路径直达导航、输入文件路径定位并打开）；**多选**（Ctrl/Shift）+ 独立按钮**删除（git rm，待提交可恢复）/ 移动到…（git mv）/ 重命名（F2）**；面板宽度拖拽记忆；右区选中即见**跨移动/重命名跟随的完整提交历史**（路径链徽标、时期徽标、移动/重命名里程碑行，"跟随移动"可开关），每条提交可**就地展开详情**、**只读打开历史版本**、**勾选任意两版比对差异**（blob 级，跨改名/移动时期有效）；移动/重命名后引导"纯变更单独提交"保证 R100 识别；资源管理器手动拖动后自动检测并给出同样引导；VS Code 资源管理器右键「查看文件历史」直达 |
| Pull/Fetch 摘要（v0.13.0；v0.13.3 重构） | 每次 Pull/Fetch 拉到新提交后弹窗展示**纯净变更摘要**（排除 Branch/Merge 等操作提交）：**作者 → 目录 → 文件** 三层分组——作者头（最新提交在前）汇总其提交数/文件数，目录头显示相对路径一次（根目录显示仓库绝对路径），组内只列文件名（**完整不截断，过长换行**）+ 工作区**大小与修改时间**；行尾按钮一键**打开文件**或**在资源管理器中定位**；同作者同文件多提交合并为一行（×N，悬停列出全部提交与说明）；重命名显示 `旧名 → 新名`；不在工作区的文件大小/时间显示 `—`（悬停提示）；中文等非 ASCII 路径不再出现 `\357\274\210` 八进制转义；顶部汇总"N 个提交 · M 位作者 · K 个文件"；`gitboard.pullFetchSummary` 设置开关，默认开启 |
| 工作副本提交（v0.7.0） | 已暂存/未暂存分组，勾选即暂存/取消；文件列表按目录分组、组内只显示文件名（v0.12.0，与提交详情一致）；文件行不再显示 ± 行数、文件名占满整行（v0.13.0）；文件名过长自动换行完整显示（不省略号截断，v0.13.3）；一键移除 `~$` 开头的 Office 临时文件（Word/PPT/Excel 锁定文件，存在时才显示按钮，v0.13.0）；单文件 HEAD↔工作副本差异（无页签）；提交 / 提交并推送 / 修订上次提交 / 暂存全部并提交；最近 8 条信息复用；丢弃（双重确认）；删除文件（v0.9.0，行内回收站按钮 / 右键，已跟踪文件删除后转未暂存 D）；行内快捷按钮：新选项卡打开（可编辑）/ 复制文件名 / 复制路径（v0.12.0），悬浮层形态不占行宽——鼠标移到行上才在行尾浮现（底色跟随所在行，v0.13.3）；文件状态刷新按钮——编辑器改动不触发自动刷新，点此立即获取（v0.12.0）；草稿按仓库持久化 |
| AI 提交信息（v0.7.0） | GitHub Copilot 生成提交信息：流式填充、可停止/重新生成/选模型；基于已暂存差异 + 近 10 条提交学习风格与语言；自动遵循 `.copilot/`、`.github/copilot-instructions.md` 等工程指示文件；复用 VS Code 当前登录账号，扩展零凭证。v0.8.1 大批量提交加固：统计与差异封顶截断（防超长 prompt 挂起）、60s 无响应自动停止、失败必解除界面锁定。v0.13.0 差异不可用（暂存超大文件/二进制/git 超时）时自动降级为**文件名 + 目录结构**推断生成，完成后元信息如实标注 |
| 合并与冲突解决（v0.10.0） | IDEA / Beyond Compare 式三栏合并器：我的版本 – 合并版本（最终保存的就是它，可编辑）– 他人版本；块级按钮（用我的/用他人/两个都要/都不要）+ 左右栏 «» 一键采纳 + 行内编辑，全程不显示 git 冲突标记，右缘冲突分布导航条；pull/提交遇冲突自动引导横幅，push 被拒引导"拉取并推送"；二进制冲突二选一 + 系统程序预览；一方删除场景（保留/采纳删除）；超限文件（>16000 行 / 2MB）显式警告并降级三选一；随时中止合并还原现场；全部解决后弹确认完成合并（merge→合并提交 / rebase→继续变基，语义自动反转）；解决进度随时落盘，重开无损 |
| 筛选 | 分支/远程/标签过滤 + 作者 + 时间段（可叠加，条件按仓库记忆） |
| 工程切换（v0.11.0） | 左侧栏「工程」区（仓库区上方）：保存常用工程文件夹（可自定义名称），双击在当前窗口切换、右键可选新窗口打开 / 重命名 / 移除；支持保存当前工作区或浏览任意文件夹添加；路径不存在时明确报错 |
| 大仓库性能 | 分页加载（500/页，自动上限可配）、DOM 虚拟滚动 + Canvas 只绘视口、.git 监视防抖自动刷新 |
| 界面 | 跟随 VS Code 明暗主题、列宽拖拽并持久化、详情面板高度百分比记忆（v0.11.0）、中英双语、状态栏当前分支、活动栏图标角标显示未提交改动文件数（v0.12.0） |

### 安装

**方式〇：扩展市场（发布后可用）**

扩展面板（Ctrl+Shift+X）搜索 **GitBoard** 安装（ID：`EmonZhang3438.gitboard`），或命令行：

```bash
code --install-extension EmonZhang3438.gitboard
```

**方式一：命令行安装 vsix（推荐）**

```bash
code --install-extension gitboard-0.14.1.vsix
```

安装后执行 **Ctrl+Shift+P → “开发者：重新加载窗口”**（每次覆盖安装新版本后都需要）。

**方式二：VS Code 界面安装**

扩展面板（Ctrl+Shift+X）→ 右上角 `···` → **“从 VSIX 安装…”** → 选择 `gitboard-0.14.1.vsix` → 重新加载窗口。

**方式三：从源码构建**

```bash
git clone <本仓库> && cd 09_GitGraph
npm install
npm run package     # 产出 gitboard-x.y.z.vsix
```

### 快速上手

1. 打开任意包含 Git 仓库的文件夹/工作区；
2. 点击**左侧活动栏的 GitBoard 图标**（或 `Ctrl+Alt+G`，或命令面板执行 `GitBoard: 打开提交图`）——主界面直接打开；
3. 单击提交行查看详情，双击变更文件打开差异编辑器，右键探索各项操作；
4. 提交代码：点击工具栏 **「▣ 工作副本」**（或 `Ctrl+Alt+C`）→ 勾选要暂存的文件 → 撰写或点 ✨ 由 Copilot 生成提交信息 → `Ctrl+Enter` 提交。

### 功能使用详解

#### 1. 界面布局

对照上方总览图的编号：**①** 工具栏（Fetch/Pull/Push/刷新/设置/版本号 + 筛选控件）；**②** 左侧栏（**工程**、仓库、本地分支含 `↑领先 ↓落后` 徽标、远程、标签）；**③** 提交图（彩色走线、节点、ref 徽标）；**④** 详情概要（SHA、作者、时间、完整注释）；**⑤** 变更文件列表；**⑥** 内联差异。详情面板高度可拖拽、可折叠（高度按百分比记忆，不同尺寸屏幕相对高度一致），位置可在设置中改为右侧。工具栏最左端的分段控件可在「**⎔ 提交图 ⇄ ☰ 纯提交 ⇄ ▣ 工作副本**」三个视图间一键切换（工作副本视图见下文第 7 节），各视图的状态互相保留。**☰ 纯提交**（v0.13.2）隐藏合并提交，只列常规提交：左侧为窄**圆点时间线**图形列（每行一个圆点标注一次提交，HEAD 提交加红色圆环），列宽固定不可拖拽。

#### 2. 浏览提交图

- 图形列：短半径圆角走线，主干直线、换轨紧凑；普通节点为实心圆，**合并提交带外环**，**HEAD 节点带 SourceTree 式红色圆环**（v0.13.0）；
- 徽标颜色：绿色=本地分支、紫色=远程分支、黄色=标签、`HEAD → main` 表示当前分支；
- 列表滚动到底部自动加载下一页（默认每页 500 条，自动加载上限 20000 条，超出后点“继续加载更多”）；
- ↑ / ↓ 键盘上下移动选中；仓库发生变更（提交/切换分支/fetch）自动防抖刷新（v0.9.1 修复刷新后列表行不重绘的问题）。
- 操作进度行（v0.9.2）：Fetch/Pull/Push/Refresh 进行时，工具栏下方出现进度条——蓝色填充按 git 进度推进（无百分比阶段为流动动画）、显示 git 明细、实时耗时，网络操作可中途取消；完成绿色闪现后自动收起，不占用常驻空间。
- 窄视口自适应（v0.9.1）：空间不足时工具栏自动换行、提交列表各列按最小宽收缩、列头与内容严格对齐、详情面板高度随窗口钳制——不再出现元素互相叠压。
- 合并与冲突解决（v0.10.0）：pull/提交产生冲突时自动切到工作副本并弹出引导横幅（逐个解决 / 全部以我为准 / 全部以他人为准 / 中止合并）；三栏合并器详见功能表；push 前检测到本地落后远端会引导"拉取并推送"，拉取无冲突自动续推；全部解决后弹确认完成合并（不再自动提交）。

#### 3. 查看提交详情与差异

- **单击提交行**：底部面板显示完整 SHA（点击复制）、作者/提交者与邮箱、作者时间/提交时间（`YYYY-MM-DD HH:mm:ss`，可在设置改为相对时间）、完整提交注释（标题+正文）；
- **单击变更文件**：右侧立即显示内联 diff。默认**紧凑模式**只显示增删行、以 `⋯ 行号 ⋯` 折叠无差异段落；点“含上下文”切换为带 3 行上下文的完整视图；
- **双击文件**（或点“差异编辑器”按钮）：打开 VS Code 内置差异编辑器，左侧为父提交版本、右侧为该提交版本，带语法高亮；
- **多选批量打开（v0.11.0）**：文件列表 Ctrl/⌘ 单击累积多选、Shift 单击范围多选，点文件头右侧 ↗ 按钮（或右键“打开选中的 N 个文件”）一次性在编辑器打开；工作区已不存在的文件自动跳过并提示；拖拽调整面板高度后按**百分比**记忆，换不同尺寸屏幕时相对高度一致；
- 合并提交按第一父提交口径显示差异（与 SourceTree 默认一致）。

#### 4. Git 操作

![操作菜单 / Operations](res/operations.png)

- **Fetch**：工具栏 ⟳，默认 `--all --prune`（可配置）；也可在侧栏远程主机/远程分支上右键按单个远程获取；打开视图时可配置自动 fetch；
- **Pull / Push**：工具栏 ⤓ / ⤒，作用于当前分支；Push 无上游时弹窗引导创建；所有网络操作显示实时进度（百分比）并可取消；
- **重置到某次提交**：提交行右键 →“重置到此提交…”，选择 soft / mixed / hard；工作区有未提交修改且选择 hard 时，必须点击红色确认按钮（防误触）；
- **切换分支**：双击侧栏分支即检出；双击远程分支弹出命名框，创建本地跟踪分支；提交行右键可“检出此提交”（分离 HEAD）。

#### 5. 筛选

![筛选 / Filters](res/filters.png)

工具栏提供三组可叠加的筛选：**分支下拉**（或单击侧栏分支/远程/标签节点）、**作者输入框**（支持 git 正则语法，输入后自动应用）、**起止日期选择器**（截止日期含当天全天）。有筛选时显示 × 一键清除；筛选无结果时空态会明确提示。条件按仓库分别记忆。

#### 5.5 工程切换（v0.11.0 新增）

左侧栏最上方新增「**工程**」区，用于在几个常用工程间快速切换 VS Code 工作区：

- **添加**：点分区标题右侧 **＋** → 「保存当前工作区」（多根工作区会逐个列出）或「浏览文件夹…」选择任意目录，输入自定义名称（默认取目录名）；
- **切换**：**双击**工程即在**当前窗口**替换为新工程；右键可选「**在新窗口打开**」「在当前窗口打开」「重命名…」「移除」「复制路径」；
- 当前工作区命中的工程自动高亮；工程列表持久化保存，重启不丢；路径已被移动/删除时打开会明确报错。

#### 6. 个性化

- **列宽**：图形/提交说明/作者/SHA 四列表头右缘可拖拽调宽（悬停高亮），自动持久化，重装不丢；时间列自适应剩余空间；
- **主题**：全部颜色消费 VS Code 主题变量，明暗自动适配；
- **语言**：默认跟随 VS Code 界面语言，可强制指定；**工具栏「A / 中 / EN」按钮**或命令 `GitBoard: 切换界面语言` 一键切换，**即时生效、无需重载**（v0.7.1）；
- **按钮反馈**：Fetch / Pull / Push / 刷新点击后按钮进入繁忙态（蓝色脉冲）、完成时短暂闪绿并 toast 说明结果——无新提交也会明确告知（“远程无新提交” / “已是最新的” / “获取完成：N 个分支引用有更新”）（v0.7.1）。

#### 7. 工作副本与提交（v0.7.0 新增）

SourceTree 式提交流程，全程不离开 GitBoard：

- **视图**：工具栏「▣ 工作副本」页签（带脏文件数徽标）或 `Ctrl+Alt+C` 进入；左右为文件列表与差异，底部为提交信息栏；活动栏 GitBoard 图标以角标显示未提交改动文件数（v0.12.0，多仓库取总和）；
- **暂存**：左栏分「已暂存 / 未暂存」两组，**勾选即 `git add`、取消勾选即取消暂存**（乐观更新）；组内再**按目录分组**——目录头显示完整路径一次（根目录显示仓库绝对路径），组内行只显示文件名，与提交详情一致（v0.12.0）；重命名显示 `旧名 → 新名`，未跟踪标 `U`；支持过滤、全部暂存/取消、右键批量操作；
- **刷新文件状态**（v0.12.0）：在编辑器里修改/保存文件不会触发 `.git` 变化（自动刷新侦听不到），点击文件列表头部的 **⟳ 刷新按钮**立即重新执行 `git status` 获取最新修改状态（图标旋转反馈），活动栏角标与工具栏徽标随之更新；
- **行内快捷按钮**（v0.12.0）：文件行悬停时行尾出现四个图标按钮——**新选项卡打开**（可编辑的真实文件，非只读 diff）、**复制文件名**、**复制文件路径**、**删除文件**；右键菜单同步提供复制文件名/复制路径；
- **看差异**：点击任一文件行，右栏显示该文件 **HEAD ↔ 工作副本的完整差异**（本次已暂存+未暂存合并，无页签）；`‹ ›` 在更改文件间逐个切换；未跟踪文件显示为全新增；
- **写提交信息**：单一多行输入框，首行即摘要（计数 50 提示）、空行后为正文；`🕘` 复用最近 8 条提交信息；草稿按仓库自动保存，切视图/重开不丢；
- **提交**：`Ctrl+Enter` 或「提交 ⏎」按钮；下拉可选 **提交并推送 / 修订上次提交**（自动载入上次信息并警示）/ **暂存全部并提交**；hooks 失败会展示完整输出；未直接推送时提交后显示绿色「推送 / 暂不」询问条——**仅当工作区仍有未提交改动时显示**（此时界面没有其他推送入口）；工作区已干净（干净空态自带 ↑ 推送按钮）或已无待推送（如已从其他入口推送）时不显示并自动隐藏（v0.12.0）；
- **AI 生成**：点 **✨** 由 GitHub Copilot 基于已暂存差异生成提交信息——流式填入输入框，可 `Esc` 停止、重新生成、切换模型；语言与风格自动学习近 10 条提交；若工程定义了 `.copilot/*.md`、`.github/copilot-instructions.md`、`.github/instructions/*.instructions.md` 指示文件将自动遵循；首次使用会请求确认（差异将发送至 Copilot 服务）。v0.8.1 针对一次性提交大量代码加固：文件统计与差异均封顶截断（防超长 prompt 挂起）、60 秒无响应自动停止并提示可重试、任何失败都会解除界面锁定；
- **丢弃**：右键文件 →「丢弃更改…」，红色双重确认后回到 HEAD（未跟踪文件直接删除）；
- **删除文件**（v0.9.0）：文件行悬停出现 🗑 按钮或右键 →「删除文件…」，确认后从磁盘移除——未跟踪文件直接消失，已跟踪文件转「未暂存」（状态 D），暂存后才计入提交；已打开该文件的编辑器标签会自动关闭。操作按钮均为达意的 SVG 图标（如「全部暂存」= 清单全勾选，与行内勾选暂存的交互直接对应）。

### 快捷键

| 按键 | 功能 |
| --- | --- |
| `Ctrl+Alt+G`（macOS `Cmd+Alt+G`） | 打开提交图 |
| `Ctrl+Alt+C`（macOS `Cmd+Alt+C`） | 打开工作副本（提交）视图并聚焦信息栏 |
| `Ctrl+Enter` | 提交（提交信息框内） |
| `Esc` | 停止 AI 生成 |
| `↑` / `↓` | 移动选中提交 |
| `Enter` | 打开文件所在差异（在详情面板中） |

### 常用设置（`Ctrl+,` 搜索 "gitboard"）

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `gitboard.gitPath` | 自动检测 | git 可执行文件路径 |
| `gitboard.commitPageSize` | 500 | 每页加载提交数（100–5000） |
| `gitboard.logOrder` | topo | 提交排序：topo（走线规整，默认）/ date（超大仓库更快） |
| `gitboard.maxAutoLoad` | 20000 | 自动加载上限 |
| `gitboard.defaultPullStrategy` | merge | pull 策略：merge / rebase / ff-only |
| `gitboard.dateFormat` | datetime | 时间格式：YYYY-MM-DD HH:mm:ss / 相对时间 / ISO |
| `gitboard.rowHeight` | default | 行高：紧凑 20 / 标准 24 / 舒适 28 |
| `gitboard.graphStyle` | curved | 走线风格：短半径圆角 / 直角折线 |
| `gitboard.detailPanelPosition` | bottom | 详情面板位置：底部 / 右侧 |
| `gitboard.language` | auto | 界面语言（工具栏 A/中/EN 按钮一键切换，即时生效） |
| `gitboard.fetchOnOpen` | true | 打开视图时自动 fetch |
| `gitboard.autoFetchInterval` | 10 | 后台自动获取间隔（分钟，SourceTree 式，0=关闭）：面板打开期间定时静默 fetch 当前仓库全部远程（不走进度条、失败不弹窗），拉到新提交后分支 ↓n 徽标与提交图自动更新（v0.13.0） |
| `gitboard.pullFetchSummary` | true | Pull/Fetch 拉到新提交后弹窗显示纯净提交摘要（排除合并提交，附变更文件清单）（v0.13.0） |
| `gitboard.startView` | graph | 打开时的初始视图：提交图 / 工作副本 / 上次使用 |
| `gitboard.ai.enabled` | true | 启用 Copilot 生成提交信息（不可用时自动隐藏入口） |
| `gitboard.ai.modelFamily` | 默认模型 | 首选 Copilot 模型 family |
| `gitboard.ai.language` | auto | 生成语言（auto = 跟随近期提交） |
| `gitboard.ai.learnFromHistory` | true | 学习近 10 条提交的风格与语言 |
| `gitboard.ai.useWorkspaceInstructions` | true | 遵循工程指示文件（`.copilot/`、`.github/`） |
| `gitboard.commit.clearMessage` | true | 提交成功后清空信息框 |
| `gitboard.commit.pushAfter` | false | 「提交后推送」复选框默认值 |

### 从源码开发

```bash
npm install
npm run watch       # F5 调试（“运行 GitBoard 扩展”）
npm run typecheck   # 双工程类型检查
npm test            # 单元测试 + 真实 git 冒烟（GITBOARD_SMOKE=1 启用）
npm run build && npm run package
```

### 常见问题

- **安装新版本后行为没变化？** 务必执行“开发者：重新加载窗口”；可对照工具栏右侧版本号确认当前构建。
- **支持 vscode.dev / github.dev 吗？** 不支持，插件需要在本机执行 git 命令。
- **超大仓库卡吗？** 分页 + 虚拟滚动保证流畅；可运行 `git commit-graph write --reachable` 进一步加速翻页。
- **✨ AI 生成按钮没出现？** 需要 VS Code ≥ 1.99 且已登录 GitHub Copilot（与 Copilot Chat 同一账号）；未登录或不可用时按钮自动隐藏，其余提交功能不受影响。也可检查 `gitboard.ai.enabled` 是否开启。
- **AI 会发送什么内容？** 已暂存差异（暂存为空时为全部更改）与工程指示文件内容，经 GitHub Copilot 服务处理（使用你当前登录的账号与配额）；首次使用会弹窗确认，超限文件只发送统计不发送内容。
- **一次性提交很多代码时 AI 会卡死吗？** 不会（v0.8.1 起）：文件统计与差异均封顶截断，prompt 始终在模型上下文内；Copilot 60 秒无响应会自动停止并提示重试/换模型；即使 git 读取差异失败也会立即报错并解锁界面，不会永久转圈。

---

## English Documentation

**[简体中文](#中文文档)** | **English**

GitBoard brings a SourceTree-style commit graph to VS Code (desktop): browse history with a colored topology, inspect commits and diffs, and run everyday Git operations from the GUI.

![Overview](res/overview.png)

### Features

| Feature | Description |
| --- | --- |
| Commit graph | Colored topology with branches, merges, criss-cross and multi-root repos; HEAD / branch / remote / tag chips; the HEAD node carries a SourceTree-style red ring so the current commit stands out at a glance (v0.13.0) |
| Commit details | Full SHA (one-click copy), author/committer, full message, changed files with status and ± line counts; Ctrl/⌘ multi-select and Shift range-select files, open them all in the editor at once (v0.11.0); panel height remembered as a percentage — identical relative height on any screen (v0.11.0); an "open in VS Code" button on the diff toolbar opens the working file directly (v0.13.0) |
| Diffs | Inline diff (compact mode shows changed lines only, `⋯` folds unchanged runs) + the built-in diff editor with syntax highlighting |
| File actions | Open working file, open any revision read-only, reveal in the system file manager (falls back to the parent folder for deleted files), copy path. Long-path support (v0.13.2): Windows paths beyond 259 chars cannot be parsed by the explorer command line, so GitBoard automatically degrades to revealing (and selecting) the deepest reachable ancestor folder |
| Git operations | Fetch (--all --prune), Pull (merge/rebase/ff-only), Push (with upstream setup), Reset to commit (soft/mixed/hard), checkout branches, checkout remote branch as local tracking, detached HEAD; SourceTree-style background auto-fetch (default 10 min, configurable via `gitboard.autoFetchInterval`, 0 = off, v0.13.0) |
| File history page (v0.14.0) | Fourth view "🗂 Files": an explorer on the left with **folder (tiles) / details** views (name / date modified / type / size — every column resizable and remembered, folders first, type icons) plus a **Win11-style address bar** (breadcrumbs ⇄ edit mode; paste a path to jump, type a file path to locate & open it); **multi-select** (Ctrl/Shift) with dedicated **Delete (git rm, recoverable before commit) / Move to… (git mv) / Rename (F2)** buttons; resizable pane width, remembered; the right panel shows the **full commit history following moves/renames** (path-chain badge, era badges, move/rename milestone rows, toggleable follow) — expand details inline, open any historical version read-only, and **compare any two versions** (blob-level diff, valid across renames/moves); moves/renames are guided to be committed alone for reliable R100 detection; manual explorer moves are detected with the same guidance; right-click a file in the VS Code explorer to jump straight to its history |
| Pull/Fetch summary (v0.13.0; reworked in v0.13.3) | After every Pull/Fetch that brings new commits, a popup shows the **pure changes** (merge/branch operations excluded) grouped by **author → directory → file**: author headers (latest first) with per-author commit/file counts, each folder path shown once as a group header (the repo root for top-level files), filename-only rows (**never truncated — wraps when long**) with the file's working-tree **size and modification time**, plus inline buttons to **open the file** or **reveal it in the explorer**; a file touched several times by the same author merges into one row (×N, hover lists all commits); renames shown as `old → new`; files missing from the working tree show `—` (noted on hover); non-ASCII paths no longer appear as `\357\274\210` octal escapes; a header line summarizes "N commits · M authors · K files"; toggle with `gitboard.pullFetchSummary`, on by default |
| Working-copy commits (v0.7.0) | Staged/Unstaged groups with checkbox staging; files grouped by directory with filename-only rows (v0.12.0, same as commit details); ± line counts removed from file rows so filenames span the row (v0.13.0); long filenames wrap instead of being ellipsized (v0.13.3); one-click removal of `~$` Office lock files (Word/PPT/Excel temp files; the broom button appears only when they exist, v0.13.0); single-file HEAD↔worktree diff (no tabs); Commit / Commit & Push / Amend / Stage-all-and-commit; recent-message reuse; discard with double confirmation; delete files (v0.9.0 — inline trash button / context menu; tracked files move to Unstaged as D); inline quick actions: open in a new tab (editable) / copy file name / copy path (v0.12.0), rendered as a floating overlay that takes no row width — it appears at the row end on hover with a background matching the row state (v0.13.3); a refresh button that re-runs `git status` on demand — editor edits don't auto-refresh (v0.12.0); per-repo message drafts |
| AI commit messages (v0.7.0) | One-click generation via GitHub Copilot: streamed inline, stop/regenerate/model picker; based on the staged diff + style learned from the last 10 commits; automatically follows `.copilot/` and `.github/` workspace instruction files; uses your signed-in VS Code account — zero credentials stored. Hardened in v0.8.1 for huge changesets: capped summary & diff (no more oversized-prompt hangs), 60s no-response auto-stop, UI always unlocks on failure. In v0.13.0, when the diff is unusable (oversized staged files / binary / git timeout) it automatically falls back to inferring from **file names and folder structure**, honestly noted in the meta line after generation |
| Filtering | Branch/remote/tag filter + author + date range, stackable and remembered per repository |
| Projects (v0.11.0) | "Projects" section above Repositories: save favorite workspace folders with custom names; double-click to switch the current window, right-click to open in a new window / rename / remove; add via "save current workspace" or browse any folder; clear error when a path no longer exists |
| Merge & conflict resolution (v0.10.0) | IDEA / Beyond Compare style 3-way merge editor: Mine – Merged (this is what gets saved, editable) – Theirs; per-chunk buttons (use mine / use theirs / keep both / keep neither) + «» one-click adopt arrows on side panes + inline editing, git conflict markers never shown, conflict-distribution minimap on the right edge; pull/commit conflicts auto-open a guidance banner, rejected pushes guide you to "pull and push"; binary conflicts reduce to pick-one-side + system-app preview; deleted-on-one-side scenarios (keep / accept deletion); oversized files (>16000 lines / 2MB) get an explicit warning and reduce to whole-file choices; abort anytime restores the pre-merge state; after everything is resolved, a confirmation finishes the merge (merge → merge commit / rebase → continue rebase, semantics flipped automatically); resolution progress is saved to the file itself — reopening is lossless |
| Large-repo performance | Paged loading, virtualized rows + viewport-only canvas rendering, debounced auto-refresh on `.git` changes (v0.9.1 fixes stale list rows after refresh); operation progress bar under the toolbar (v0.9.2): blue fill tracks git progress, indeterminate shimmer otherwise, git detail text, live elapsed time, cancellable network ops, green flash on completion; narrow-viewport adaptive layout (v0.9.1): toolbar wraps, columns shrink to minimums, header/body stay aligned, detail panel height clamps — no more overlapping elements; merge & conflict resolution (v0.10.0): pull/commit conflicts auto-open a guidance banner in the working-copy view (resolve one by one / all mine / all theirs / abort), rejected pushes guide you to pull first and auto-continue when clean, and a confirmation finishes the merge after everything is resolved |
| UI | Follows VS Code light/dark themes, drag-resizable persisted columns, English/中文, status-bar branch, activity-bar icon badge with the uncommitted-change count (v0.12.0) |

### Install

**Option 0 — Marketplace (once published)**

Search **GitBoard** in the Extensions view (Ctrl+Shift+X), ID: `EmonZhang3438.gitboard`, or:

```bash
code --install-extension EmonZhang3438.gitboard
```

**Option 1 — CLI (recommended)**

```bash
code --install-extension gitboard-0.14.1.vsix
```

Then run **Ctrl+Shift+P → “Developer: Reload Window”** (required after every upgrade).

**Option 2 — From the UI**

Extensions view (Ctrl+Shift+X) → `···` → **“Install from VSIX…”** → pick the file → reload.

**Option 3 — From source**

```bash
npm install && npm run package
```

### Quick Start

1. Open a folder/workspace containing Git repositories;
2. Click the **GitBoard icon in the Activity Bar** (or press `Ctrl+Alt+G`, or run `GitBoard: Open Commit Graph`);
3. Click a commit row for details, double-click a file to open the diff editor, right-click everywhere for more actions;
4. To commit: switch to the **“▣ Working Copy”** tab on the toolbar (or `Ctrl+Alt+C`) → check the files to stage → write the message or click ✨ to generate it with Copilot → `Ctrl+Enter` to commit.

### Using the Features

**Layout** — see the numbered badges in the overview: ① toolbar & filters, ② branch/remote/tag tree, ③ commit graph, ④ commit summary, ⑤ changed files, ⑥ inline diff. The detail panel is drag-resizable and collapsible. The segmented control on the far left of the toolbar switches between the **Graph**, **Pure** and **Working Copy** views (see below); state is preserved across switches. The **Pure** view (v0.13.2) lists regular commits only (merges hidden) with a slim **dot-timeline** graph column — one dot per commit, HEAD marked with a red ring; the column width is fixed.

**Browsing** — solid dots are commits, merged commits carry a ring, the HEAD node carries a SourceTree-style red ring (v0.13.0). Chips: green = local branch, purple = remote, yellow = tag, `HEAD → main` = current branch. Scrolling near the bottom auto-loads the next page (500/page by default; auto-load caps at 20,000 with a manual “Load more” button). `↑`/`↓` move the selection.

**Details & diffs** — click a row to load the full SHA, author/committer, dates (`YYYY-MM-DD HH:mm:ss` by default) and the complete message. Click a file to preview its diff inline — compact mode highlights only added/removed lines and folds unchanged runs into `⋯` rows; switch to “With context” for full context. Double-click a file (or use the header button) to open VS Code’s built-in diff editor (parent revision ↔ commit). Merge commits are diffed against their first parent. **Multi-select & open (v0.11.0)**: Ctrl/⌘-click toggles files into a selection, Shift-click selects a range; the ↗ button in the files header (or the context menu) opens all selected files in the editor at once — files no longer in the working tree are skipped with a notice. The panel height you drag is remembered as a **percentage**, so it looks identical (relatively) on any screen size.

![Operations](res/operations.png)

**Operations** — ① commit-row context menu (detached checkout, reset, copy SHA/subject); ② file context menu (open working file, read-only revision, reveal in file manager, copy path); ③ branch menu (checkout/pull/push/copy; double-click a branch to check it out, single-click to filter the graph; double-click a remote branch to create a local tracking branch); ④ the reset dialog — hard resets require an explicit red confirmation when uncommitted changes exist. Fetch/Pull/Push show live progress and can be cancelled.

![Filters](res/filters.png)

**Filtering** — branch dropdown (or click a tree node), author box (git regex supported, auto-applies), and a date range (the end date includes the whole day). Filters stack, are remembered per repository, and map to `git log --ref / --author / --since / --until`.

**Projects (new in v0.11.0)** — the **Projects** section at the top of the sidebar (above Repositories) stores your favorite workspace folders for instant switching: click **＋** to save the current workspace or browse any folder (custom names supported); **double-click** a project to replace the current window with it, or right-click for *Open in new window / Rename / Remove / Copy path*. The project matching the current workspace is highlighted; the list persists across sessions, and a moved/deleted path produces a clear error.

**Personalization** — drag column borders in the header to resize (persisted across sessions); time column absorbs the remaining space; colors follow your theme; the UI language follows VS Code by default and can be switched instantly (no reload) via the **A / 中 / EN** toolbar button or the `GitBoard: Switch UI Language` command (v0.7.1). Fetch / Pull / Push / Refresh buttons show a busy pulse while running and flash green on completion, with result toasts that are explicit even when nothing changed (“remote has nothing new” / “already up to date” / “N branch refs updated”) (v0.7.1).

**Working copy & commits (new in v0.7.0)** — a SourceTree-style flow without leaving GitBoard. Switch via the “▣ Working Copy” tab (dirty-file badge) or `Ctrl+Alt+C`. The left pane groups **Staged / Unstaged** files — **check a box to `git add`, uncheck to unstage** (optimistic updates); renames show `old → new`, untracked files are marked `U`. Clicking a file shows its **full HEAD↔worktree diff** on the right (staged + unstaged combined, no tabs), with `‹ ›` to walk through changed files. The bottom bar has a single multi-line message box (first line = subject, live 50-char counter), a 🕘 recent-messages picker, and the **Commit ⏎** button with a dropdown: Commit & Push / Amend last commit / Stage-all-and-commit; `Ctrl+Enter` commits, drafts are saved per repository. When the commit was not pushed directly, a green "Push / Not now" ask-bar appears — **only if uncommitted changes remain** (no other push affordance exists then); it stays hidden and auto-hides once the working copy is clean (the clean state already offers a Push button) or nothing is left to push (v0.12.0). **✨ AI** generates the message from your staged diff via GitHub Copilot — streamed inline, stop with `Esc`, regenerate or switch models at will; language and style are learned from the last 10 commits, and workspace instruction files (`.copilot/*.md`, `.github/copilot-instructions.md`, `.github/instructions/*.md`) are followed automatically; a one-time confirmation explains what gets sent. Hardened in v0.8.1 for huge changesets: summary and diff are both capped (no more oversized-prompt hangs), a 60s no-response watchdog stops the request automatically, and any failure always unlocks the UI. Right-click → “Discard…” resets files to HEAD (untracked files are deleted) behind a red double confirmation. **Delete files** (v0.9.0): hover a file row for the 🗑 button (or right-click → “Delete file…”), confirm, and the file is removed from disk — untracked files disappear, tracked files move to Unstaged (status D) and count toward the commit only after staging; editor tabs for deleted files close automatically. All working-copy buttons now use meaningful SVG icons (e.g. “stage all” = a fully checked checklist, mirroring the checkbox-to-stage interaction). **New in v0.12.0**: the file list is grouped by directory — the directory path is shown once per group (the repository root for top-level files) and rows show filenames only, matching the commit-details list; a **⟳ refresh button** in the list header re-runs `git status` immediately (edits made in the editor never touch `.git`, so they cannot auto-refresh — click to fetch the latest status, with a spinning-icon feedback); hovering a file row reveals quick actions at the row end — **open in a new tab** (the editable working file, not a read-only diff), **copy file name**, **copy path** — alongside delete; and the GitBoard activity-bar icon now carries a badge with the total number of uncommitted changed files (summed across workspace repositories).

### Keybindings & Settings

- `Ctrl+Alt+G` / `Cmd+Alt+G` — open the graph; `Ctrl+Alt+C` — open the Working Copy (commit) view; `Ctrl+Enter` — commit (inside the message box); `Esc` — stop AI generation; `↑`/`↓` — move selection.
- Search “gitboard” in Settings for page size, auto-load limit, pull strategy, date format, row height, graph style, detail panel position, language, auto-fetch on open, plus the v0.7.0 additions: `startView`, `ai.enabled` / `ai.modelFamily` / `ai.language` / `ai.learnFromHistory` / `ai.useWorkspaceInstructions`, `commit.clearMessage` / `commit.pushAfter`.

### FAQ

- **Nothing changed after upgrading?** Run “Developer: Reload Window”; the version label on the toolbar right edge tells you which build is live.
- **vscode.dev?** Not supported — the extension runs your local `git`.
- **Huge repos?** Paging + virtualization keep it smooth; `git commit-graph write --reachable` speeds up paging further.
- **No ✨ AI button?** AI commit messages need VS Code ≥ 1.99 and an active GitHub Copilot sign-in (the same account as Copilot Chat). The button hides itself when unavailable — everything else keeps working. Also check `gitboard.ai.enabled`.
- **What does AI send?** The staged diff (or all changes when nothing is staged) plus workspace instruction files, processed by the GitHub Copilot service under your signed-in account and quota; a one-time confirmation appears before the first use, and oversized files are reduced to summary stats only.
- **Does AI hang on huge changesets?** No (since v0.8.1): summary and diff are both capped so the prompt always fits the model context; a 60s no-response watchdog stops the request with a retry hint; even a failed diff read reports an error immediately and unlocks the UI — no infinite spinner.

### Development

```bash
npm install
npm run watch        # then press F5 (“运行 GitBoard 扩展”)
npm run typecheck && npm test
npm run build && npm run package
```

---

## 许可证 / License

[MIT](./LICENSE) © 2026 Emon
