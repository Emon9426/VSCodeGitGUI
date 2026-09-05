# 冲突解决功能重设计方案（Issue #7 根因治理）

> 状态：设计稿（待拍板实施）
> 调查日期：2026-09-05 · 基线：main @ 16082e1（v0.19.2）
> 关联：[#7 冲突解决功能无效](https://github.com/Emon9426/VSCodeGitGUI/issues/7)

## 1. 症状

进入冲突解决功能后，点击「以我的版本为准 / 以远端版本为准」（工作副本冲突行「我的/对方的」、合并器「整文件快选 ▾」等入口）与「解决冲突」相关按钮，均无任何反应：无进度、无报错、界面状态不变。

## 2. 排查过程与证据

| 层 | 结论 |
|---|---|
| git 层 | `checkout --ours/--theirs -- <path>` + `add -- <path>` 序列在冲突仓库直接执行完全正常（UU → 干净） |
| 前端 DOM/事件 | 冲突行按钮、合并器 chunkBar、整文件快选菜单的事件绑定与浮层 z-index（菜单 1000 > 合并器 900 > 模态 1100）均正常 |
| 真机·干净环境 | 隔离 profile + CDP + extensionDevelopmentPath（当前 main）：冲突行 Mine/Theirs、合并器块级「用我的」、整文件快选「以我的为准」三条路径**全部正常生效** |
| 真机·网络挂起环境 | 向「黑洞远端」（TCP 接受连接但永不响应）点一次 Fetch 后再点冲突行 Mine：**整整 65 秒零反馈**；Fetch 被 60s lowSpeed 中断放行队列后，Mine 才悄悄生效（且成功全程无提示） |
| 版本考古 | 报障时用户在 v0.19.1：显式 fetch/pull/push **无超时、无低速中断、无看门狗**（仅 autoFetch 的 HTTP 路径有 45s lowSpeed；SSH 协议完全无防护）。用户环境 GitHub 间歇阻断是常态 |

## 3. 根因

**直接根因**：冲突解决按钮（`merge.resolve` → `workResolveConflict` → `runner.run`）进入 per-repo **单条串行操作队列**。当队列被一个挂起的网络操作堵住时（autoFetch 的 `fetch --all` 或残留的 fetch/pull）：

- v0.19.1：网络 op 无任何超时 → 队列**无限期**卡死 → 冲突解决点击后 op 永久排队、永不执行 → 表现为「点击无反应」；
- 当前 main：有 45/60s lowSpeed + 180s 看门狗 → 卡死有界，但窗口期内点击依然**零反馈**（实测 65 秒）。

**时机耦合**：pull 产生冲突的时刻恰恰是网络最可能已劣化的时刻（pull 刚失败/超时），用户此刻进入冲突解决流程，autoFetch 又每 10 分钟往同一条队列里补一个 fetch——三个因素叠加，命中概率极高。

### 设计缺陷（当前 main 仍存在）

1. **排队即失声**：`resolveConflict` 等本地 op 入队时不发 opProgress（`workResolveConflict` 不发初始进度，命令本身也无 stderr 输出），成功时设计为静默——排队期间 UI 零反馈，用户无法区分「已排队 / 在跑 / 没点上」。
2. **本地与网络无隔离**：秒级本地 op（resolveConflict/stage/unstage/discard…）与长耗时网络 op（fetch/pull/push…）共用一条串行队列，无优先级。
3. **autoFetch 绕过去重**：`autoFetchTick` 直接调 `runner.run`，不经 `startOp`——v0.19.2 的 `netInFlight` 同类去重只覆盖用户显式网络操作，后台轮询没盖住。
4. **成功也无确认**：resolveConflict 成功仅靠冲突行消失间接反馈；若 workState 刷新慢或被去重吞掉，连这个反馈都没有。

## 4. 重设计

### 4.1 目标与原则

| # | 原则 | 含义 |
|---|---|---|
| P1 | 本地优先 | 冲突解决/暂存/丢弃是纯本地秒级操作，**永不**被网络操作堵在后面 |
| P2 | 入队即反馈 | 任何 op 从点击那刻起必须有可见状态：排队中（第 N 位）→ 执行中 → 完成/失败 |
| P3 | 后台让路 | autoFetch 是低优先级后台任务，不与用户操作争队列；忙时直接跳过本轮 |
| P4 | 乐观 UI | 冲突行点击后立即进入 resolving 态，失败回滚并提示 |

### 4.2 方案 A：队列拆分——本地/网络双队列

`OpRunner` 内把单条 per-repo 队列拆为两条：

- **local 队列**：stage / unstage / discard / discardClean / resolveConflict / resolveDelete / commit / commitNoEdit / mergeContinue / mergeAbort / checkout / reset / moveFolder / renamePath / deletePaths
- **net 队列**：fetch / pull / push / tagPush / tagDeleteRemote（pull 全程留在 net 队列，它是含本地 merge 阶段的整体 op）

index 竞争处理：双队列并行后 `git index.lock` 可能瞬时冲突（pull 的 merge 阶段 vs 本地 stage）。本地 op 遇 `index.lock`（退出码非 0 且 stderr 含 `index.lock`）自动重试 1 次，退避 400ms；仍失败按普通失败上报。

`runner.run` 签名不变，内部按 `spec.kind` 分道；panel 侧零改动即可获得「网络挂起不再堵本地」。

### 4.3 方案 B：排队可见性

- `runner.run` 入队时回调 `onQueued(position)`；panel 转发 `opProgress { queued: true, position }`（协议向后兼容，旧字段不动）。
- 前端 opstatus 显示「⏳ 第 N 位排队」；轮到执行时照常切换为执行态。
- **本地 op 一律发初始 opProgress**（`workResolveConflict` 补上；`startWorkOp` 的 quiet 仅保留「成功不弹 toast」，进度不静音）。
- resolveConflict 成功反馈：opstatus 绿闪 + 对应按钮闪绿（复用 `toolbar.flash` / `opstatus.finish` 机制），不弹 toast（行消失即结果反馈）。

### 4.4 方案 C：autoFetch 纪律

- `autoFetchTick` 入队前检查：`netInFlight` 已登记 fetch，或 net 队列非空 → **跳过本轮**（输出通道记日志），下个周期再来。
- 后台 fetch 统一纳入 `netInFlight` 登记（提取 `enqueueNet()` 供 startOp 与 autoFetchTick 共用）。
- 保留 background fetch 的 45s lowSpeed + 180s 看门狗。

### 4.5 方案 D：冲突解决交互补强

- 冲突行「我的/对方的」点击后：行内立即转 resolving 态（spinner + 禁用按钮），workState 到达后确认；>5s 未确认转琥珀提示「仍在执行/排队」。
- 合并器内 `merge.resolve` / `merge.deleteAccept` 同样处理（块级纯本地按钮不受影响）。
- 「完成合并」对 `kind='other'`（cherry-pick 等场景）从抛错改为明确引导文案（i18n 已有 `mergeFinishUnsupported`，改为 toast 引导而非 error dialog）。

## 5. 测试与验收

### 测试

- **单测（runnerOps）**：fake executor 挂起 net op，断言 local op 不被阻塞完成；index.lock 冲突重试；onQueued 回调与位置。
- **单测（panel 侧逻辑）**：autoFetchTick 在 netInFlight 已登记/队列非空时跳过。
- **真机回归**：复用本次调查脚本（黑洞远端 + CDP）验证验收标准 1/2。

### 验收标准（对照 Issue #7）

1. 黑洞远端 fetch 挂起期间点「我的/对方的」→ **1s 内出现排队反馈，且本地 op 在 2s 内完成**（不被 fetch 堵）。
2. 全流程不存在「点击后无任何反馈」的窗口（排队/执行/成功/失败至少一态可见）。
3. 既有 typecheck + vitest 全绿，新增队列测试通过。
4. 「拉取并推送」进入冲突 → 解决 → 完成合并后弹统一推送确认，确认后一次推送全部新提交；无推送意图的合并完成后不打扰。

## 6. 实施切分建议

| 步骤 | 内容 | 风险 |
|---|---|---|
| 1 | 方案 C（autoFetch 让路 + 统一登记） | 低，独立可先行 |
| 2 | 方案 A（双队列拆分 + index.lock 重试） | 中，需回归 pull 期间 stage 场景 |
| 3 | 方案 B（排队可见性 + 协议扩展） | 低 |
| 4 | 方案 D（乐观 UI + other 引导文案） | 低 |
| 5 | 方案 E（收尾链：完成合并 → 统一推送确认） | 低 |

## 7. 第二轮修订：本地优先模型与业界对照（2026-09-05，应「解决走本地、完成后统一推送」需求）

### 7.1 核心结论

**冲突解决本来就是纯本地操作，无需改变解决流程本身。** 远端内容在 pull 阶段就已完整下载到本地对象库与 index 暂存阶段（`:1` 基础版 / `:2` / `:3`）；选边（`checkout --ours/--theirs`）、合并器写回、`add`、`commit --no-edit` 全程零网络。Issue #7 的病根不是解决流程碰了网络，而是**本地操作在串行队列里被无关的挂起网络操作堵死**。因此「本地处理方案」的正确落地方式 = 方案 A（双队列）+ 方案 C（autoFetch 让路）：网络状态再差，解决链路也完整可用。网络只出现在两处，且都在用户掌控的边界上：

| 边界 | 网络动作 | 说明 |
|---|---|---|
| 入口 | pull/fetch 拉下冲突提交 | 不可省——远端内容必须先到本地 |
| 收尾 | 统一推送 | 唯一收尾网络步骤，显式确认、失败可独立重试（Post-Op Verify 已有） |

### 7.2 方案 E：收尾链——「完成合并 → 统一推送」

现有 `pendingPushAfterPull`（拉取并推送遇冲突暂停、解决后续推）已是该模型雏形，升级为一等公民：

1. 进入冲突流程时记住来源（拉取并推送 / 用户勾选推送 / 普通合并）；
2. 「完成合并」（本地 merge commit / `rebase --continue`）成功后：来源带推送意图 → 弹统一推送确认条（复用现有 pushq 询问条形态），一键推送全部新提交（合并提交+此前未推的本地提交——`push origin HEAD` 本就整分支上传，天然「统一」）；
3. 来源无推送意图 → 不打扰，推送留给用户随时显式点（工具栏 Push / 干净空态按钮）；
4. **不自动推送**：合并提交是用户刚逐块手动取舍的内容，静默推远端风险大；业界两家标杆同样把推送留作显式步骤（见 7.3）；
5. 推送失败独立反馈与重试（已有 verify 琥珀警示 + push 拒绝引导，不回滚本地解决成果）。

### 7.3 业界对照：SourceTree 与 IntelliJ IDEA

| 维度 | SourceTree | IntelliJ IDEA | GitBoard 现状 → 方向 |
|---|---|---|---|
| 选边操作 | Resolve Using 'Mine'/'Theirs' = `checkout --ours/--theirs` + 自动暂存 | Accept Yours/Theirs（等价选边+落盘） | 同机制（`checkout`+`add`），已对齐 |
| 命名语义 | mine/theirs 直出 git 语义，合并方向一换就反，官方工单自认「misleading」（SRCTREE-1670/1579/2806） | Accept Yours/Theirs 同样有方向困惑，且 Accept 不可撤销、无确认 | **已更优**：语义侧「我的/他人的」+ rebase 自动反转（v0.18.1），重选可撤销 |
| 手动合并 | 外部 merge 工具 | 内置三栏对话框（左我的只读/右对方只读/中结果可编辑，初始为 base），可重开、可按文件 Revert | 内置三栏合并器（初始为 mine），块级操作+重选，能力对齐 |
| 何时推送 | Push 永远是独立显式工具栏操作，解决+commit 后不自动推 | 同：文档明确推送不在冲突流程内（Ctrl+Shift+K 独立步骤），不自动推 | → 方案 E：显式确认的统一推送收尾，不自动推 |
| 网络与本地隔离 | **无解**：fetch/push 挂起堆积 git 进程、堵界面的社区工单长期存在（认证静默失败→无限挂起等） | git 任务走后台 task，编辑器不阻塞；后台 VCS task 也有挂起报告，但本地解决操作不依赖网络任务 | → 方案 A+C：双队列 + autoFetch 让路，**超过两家标杆** |
| 后台自动获取 | 有（默认关） | 有（可配置间隔） | 有（默认 10 分钟）→ 方案 C 给它让路纪律 |

**两点顺带确认**：① IDEA 的「Resolve All Simple Conflicts」（自动应用非冲突改动）在 GitBoard 中天然存在——合并器的公共段即自动保留的非冲突改动；② IDEA 中栏初始为 base 版本，GitBoard 为 mine 版本，维持 v1.3 设计决议不变。

## 8. 具体实现设计（第三轮落地稿，2026-09-05）

> 每个设计元素标注其来源的 IDEA 行为（`[IDEA-x]`），便于对照评审。

### 8.0 IDEA 模式 → 本方案落点映射

| IDEA 行为 | 本方案落点 |
|---|---|
| git 任务全部走后台 task，编辑器不阻塞 | §8.1 双队列（runner.ts） |
| 冲突解决全程本地，推送不在解决流程内 | §8.3 autoFetch 让路 + 本地链路零网络 |
| Accept and Finish 一键完成合并 | §8.5 完成合并按钮（既有 merge.finish，补执行反馈） |
| 推送 = 显式独立步骤（Ctrl+Shift+K），绝不自动推 | §8.4 统一推送确认条（pushq 复用，取消现有自动续推） |
| 非模态：冲突对话框可关可重开，状态保持 | merge view 已具备（进度落盘）——e2e 固化回归断言 |
| 按文件 Revert conflict resolution | P2 登记不动（§8.6） |

### 8.1 runner.ts：本地/网络双队列 + 排队回调 + 撞锁重试 `[IDEA-后台 task]`

```ts
// 新增（模块级）
const NET_KINDS = new Set<OpSpec['kind']>(['fetch', 'pull', 'push', 'tagPush', 'tagDeleteRemote']);

// OpRunner 字段：queues 一条 → 两条 + 深度表
private readonly localQueues = new Map<string, Promise<void>>();
private readonly netQueues = new Map<string, Promise<void>>();

// run 签名追加可选回调（向后兼容，现有调用不传行为不变）
async run(root, spec, opId, onProgress, buildDone, onQueued?: (position: number) => void)
```

- **选道**：`lane = NET_KINDS.has(spec.kind) ? net : local`；队列与深度按 lane 取，run() 其余逻辑不变（网络 op 之间、本地 op 之间仍严格串行，git 写安全性不降级）。
- **onQueued(position)**：入队时同步回调，position = 同道同仓库前方排队的 op 数（0 = 立即执行）；供 panel 转发排队态。
- **`laneBusy(root, lane): boolean`** 新增公开方法：该道当前有执行中或排队中的 op。
- **index.lock 单命令重试**：execute 的命令循环改为 `execWithLockRetry`——捕获 `GitError(E_GIT_EXIT)` 且 stderrTail 含 `index.lock` 时，退避 400ms 对**同一条命令**重试一次（命令序列粒度：checkout 成功后 add 撞锁只重试 add），仍失败原样抛出。看门狗/截断逻辑不动。双道并行后 pull 的本地 merge 阶段与本地 op 的 index 竞争由它兜底。

### 8.2 协议扩展：opProgress 排队态 `[IDEA-后台 task 可感知]`

```ts
// protocol.ts opProgress 增加可选字段（旧字段不动，向后兼容）
{ t: 'opProgress', opId, kind, text, pct?, queued?: boolean, position?: number }
```

- **opStatus.ts** 渲染规则：`op.queued === true` → 图标 `⏳`、text 显示 `S.t('opQueued', { n: position })`、进度条保持 indet；执行开始时 panel 发的既有初始 opProgress（text:''）自然切换为执行态。
- panel 发送规则：`onQueued(position > 0)` 才发 queued 消息（position=0 与既有初始进度重合，不发）；本地 op（含 resolveConflict/stage/unstage）**一律补发初始 opProgress**——`workResolveConflict` 加初始 post，`startWorkOp` 的 quiet 语义收窄为仅「成功无 toast」。

### 8.3 panel.ts：autoFetch 让路 + 统一网络登记 `[IDEA-推送/拉取与本地操作互不阻塞]`

- `startOp` 的 netInFlight 登记抽为 **`enqueueNet(spec): boolean`**（登记并返回是否允许入队）；autoFetchTick 改走：
  ```ts
  if (this.runner.laneBusy(root, 'net')) { this.channel.appendLine('[autofetch] net lane busy, skipped'); return; }
  if (!this.enqueueNet({ kind: 'fetch', ... })) return;   // 同 kind 在途也跳过
  ```
- 保留 background fetch 的 45s lowSpeed + 180s 看门狗。
- `mergeFinish` 对 `kind='other'` **不再 throw**：改为 `post notify warn`（新文案 mergeFinishOtherHint 引导手动提交），RPC 正常返回。

### 8.4 前端：统一推送收尾 + 乐观 UI `[IDEA-显式推送 / 非模态反馈]`

**统一推送收尾（main.ts + commitBar.ts）**——现状 `pendingPushAfterPull` 在 workState handler 里 `!merging` 即 `app.runPush()` 自动推，改为确认条：

```ts
if (pendingPushAfterPull) {
  pendingPushAfterPull = false;
  if (!m.state.merging) commitBar.showPushAfterResolve();   // 旧：app.runPush()
  else toast('warn', S.t('mergePushPaused'));
}
```

- `commitBar.showPushAfterResolve()`：复用现有 pushq 询问条（文案换 pushqResolveText「✓ 冲突已解决并完成合并」，按钮=立即推送/暂不；input 事件让位、autoHidePushq 联动全部复用，零新机制）。
- `git push origin HEAD` 整分支上传，天然一次推完合并提交 + 此前全部未推提交 = 「统一推送」。

**冲突行乐观态（workView.ts + state.ts）**：

- `S.work.resolving: Set<string>`（repoState 换仓库分支里 clear）。
- 「我的/对方的/全部以我为准」点击 → `resolving.add(path)` + update()：行首状态码 `C` 换 `⏳`、行内三按钮 disabled；同时挂 5s 定时器，未确认则 toast `resolveSlowHint`（琥珀）提示仍在排队/执行。
- 清理双保险：opResult(kind=resolveConflict) 到达（无论成败）清 path；workState 到达且 path 已离开 conflicts 组也清。失败走既有 error 弹窗，行回可点状态可重试。
- mergeView：整文件快选菜单项与特殊会话（二进制/超限/删除侧）pick 按钮点击后 disabled 至 opResult；块级按钮纯本地不受影响。

### 8.5 完成合并 = Accept and Finish `[IDEA-Accept and Finish]`

- 保留现有确认弹窗（merge 显 MERGE_MSG 预览 / rebase 显重放说明——与 IDEA 完成语义对齐）；
- 补执行反馈：确认后 finishBtn 进入 spinner + disabled 直至 opResult，防连点重复 `commit --no-edit`；
- 成功后按 §8.4 由 pushq 确认条承接推送（有意图才出现）。

### 8.6 P2 登记（本轮不做，按规范开 Issue 跟进）

- 排队 op 的 UI 取消入口（runner F4 语义已支持，仅缺 UI）；
- 行内「重置解决」（IDEA Revert conflict resolution）：`git restore --staged -- <path>` + `git checkout -m -- <path>` 重建冲突态；
- 网络道内按 remote 细分并行（fetch 与 push 互不排队）。

### 8.7 i18n 新键（中 / en）

| 键 | zh-CN | en |
|---|---|---|
| opQueued | 排队中 · 第 {n} 位 | Queued · #{n} |
| workResolving | 解决中… | Resolving… |
| resolveSlowHint | 操作仍在排队或执行中，请稍候 | Operation still queued or running |
| pushqResolveText | ✓ 冲突已解决并完成合并 | ✓ Conflicts resolved, merge finished |
| mergeFinishOtherHint | 此场景（cherry-pick 等）请手动完成提交 | Finish manually for this scenario (cherry-pick, etc.) |

### 8.8 测试设计（对照 §5 验收标准）

**单测 test/unit/runnerQueue.test.ts（fake executor）**：
1. net op 永挂（exec 不 resolve）→ 随后入队 local op 在 50ms 内完成（同道不串台）；
2. onQueued 位置：连排 3 个 local op 位置依次 0/1/2；
3. index.lock 重试：首次返回 E_GIT_EXIT 且 stderr 含 `index.lock`，重试成功 → op 成功且该命令恰执行 2 次；命令序列只重试撞锁那条；
4. laneBusy：net 挂起时 (root,'net')=true、(root,'local')=false；
5. autoFetch 让路判定纯函数（laneBusy + 同 kind 在途 → skip）。

**集成（GITGRAPH_SMOKE 真实仓库）**：既有 resolveConflict 序列回归 + 并发撞锁路径（预置 .git/index.lock 制造一次失败后删除）。

**真机 e2e（升级本轮 %TEMP%/gitboard-issue7-wedge.js 为 test/e2e/cdp-verify-queue.js）**：
6. 黑洞 fetch 挂起 → 点「Mine」→ ≤1s 出现排队/执行反馈、≤2s 冲突行消失（本地道直通）；
7. 正常远端「拉取并推送」出冲突 → 解决 → 完成合并 → pushq 确认条出现且**不自动推**；点「立即推送」成功；
8. 完成合并确认后按钮 spinner 禁用；kind='other' 场景 toast 引导不弹错；
9. 回归：干净环境三条解决路径照常；autoFetch 在 net 道忙时跳过（输出通道可查日志）。

### 8.9 实施顺序与工作量（Issue #7 修复分支内完成）

| 步骤 | 内容 | 工作量 |
|---|---|---|
| 1 | §8.3 autoFetch 让路 + enqueueNet | 0.5 日 |
| 2 | §8.1/8.2 双队列 + onQueued + 撞锁重试（含单测 1-5） | 1 日 |
| 3 | §8.2 前端排队渲染 + 本地 op 初始进度 | 0.5 日 |
| 4 | §8.4/8.5 乐观态 + 统一推送收尾 + other 引导 | 1 日 |
| 5 | §8.8 真机 e2e 矩阵 | 0.5 日 |

合计约 3.5 人日；改动面：`src/ops/runner.ts`、`src/webview/panel.ts`、`src/common/protocol.ts`、`src/common/i18n.ts`、`src/ui/main.ts`、`src/ui/state.ts`、`src/ui/app/{opStatus,workView,commitBar,mergeView}.ts` + 新增单测。


