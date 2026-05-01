# Permissions

`src/permissions/`。

## 为什么这样设计

权限是一道**闸门**而不是过滤器：每个工具调用必经 advisor 评估，得到 allow / deny / ask 决定。这条切分让权限逻辑和工具实现完全解耦——工具实现里**没有任何**权限检查代码，所有规则都在 advisor 里。

Bash 是最危险的工具，所以单独有 tree-sitter 解析器，把命令解析成 AST 后再分类。这一步是异步的（tree-sitter 加载有 IO 开销），所以分类函数有同步和异步两版。

## 三个 Permission Mode

`PermissionMode = "read_only" | "reversible" | "yolo"`（`permissions/types.ts`）

- `read_only` —— 只读。写、bash、网络一律拒
- `reversible` —— 读 + 可逆写。破坏性操作要审批
- `yolo` —— 全放行不问

`PERMISSION_MODE_ORDER` 给三档排序，`effectiveMode(sessionMode, agentCeiling?)` 取两者更严的。Agent ceiling 用来给子代理设上限——比如父 session 是 yolo 但 spawn 出来的 explorer 子代理强制 read_only。

## 工具分类

`classifyTool(toolName, args)` —— 同步分类，返回 `InvocationAssessment = { permissionClass, summary, scope? }`。

`classifyToolAsync(toolName, args)` —— 异步版，bash 必须走这条（要 tree-sitter 解析）。

`initBashParser()` —— 必须在第一次调 `classifyToolAsync` 之前调一次，加载 tree-sitter wasm。Session 构造或 server 启动时统一调。

`PermissionClass`（`types.ts`）：`safe_read` / `write` / `destructive` / `network` / `system` / `unknown`。

## Bash Parser

`permissions/bash/parser.ts` 用 `web-tree-sitter` + `tree-sitter-bash` 把 bash 命令解析成 AST，然后分析：
- 是否包含 redirect / pipe
- 是否调危险命令（rm -rf、mkfs 等）
- 是否触发网络（curl、wget、ssh）
- 文件路径作用域

`permissions/bash/types.ts` 定义解析后的命令结构类型。

这一切的目的是**不执行就能判断**——纯静态分析。

## Rules

`PermissionRuleStore`（`permissions/rules.ts`）持久规则集合。运行时通过审批选项 add 规则。

四层存储（优先级从高到低）：

| 层 | 路径 | 读写 | 生命周期 |
|---|---|---|---|
| session | 内存 | 读写 | 会话结束消失 |
| workspace | `{projectRoot}/.fermi/permissions.json` | 只读 | 用户手动管理 |
| project | `~/.fermi/projects/<slug>/permissions.json` | 读写 | 系统自动持久化 |
| global | `~/.fermi/permissions.json` | 读写 | 跨项目 |

系统写入（审批选择"project"/"global"）只写 project/global 层，不污染 workspace。workspace 层由用户手动创建，系统只读取。

`PermissionRule`（`types.ts`）：`{ tool, pattern?, scope?, decision }`。
`PermissionRuleFile`：存储 shape。

## Advisor

`PermissionAdvisor`（`permissions/advisor.ts`）实现 `GateAdvisor` 接口，被加进 Session 的 `ToolGate`。

工作流：
1. 先调 `classifyTool` / `classifyToolAsync` 拿 `InvocationAssessment`
2. 查 `PermissionRuleStore` 看有没有匹配规则（**read_only 模式跳过此步**——mode 是硬上限）
3. 查决策矩阵（mode × class → allow/ask）
4. 决定：直接 allow / 跑审批 ask
5. 构造审批选项（read_only 下只给 Allow once / Deny，不提供持久化规则选项）

`AdvisorDecision`（`types.ts`）：`"allow"` / `"deny"` / `{ kind: "ask", ... }`。
`ApprovalOffer`（`types.ts`）：`{ type, label, scope?, rule? }`，UI 让用户选"允许一次" / "永久允许此模式"等。
`ApprovalOfferType`：`"tool_once"` / `"tool_pattern"`。

## 与 Tool Loop 的桥

`ToolPreflightDecision` 是三态：`allow` / `deny` / `ask`。审批流程通过正常返回值传递：

1. `PermissionAdvisor.evaluate()` 返回 `GateDecision`，ask 分支携带完整的 `offers` 和 `assessment`
2. Session 的 `_beforeToolExecute` 从 Gate 拿到 ask 决定后，就地构造 `ApprovalRequest`，返回 `{ kind: "ask", ask }`
3. tool-loop 收到 ask 返回值，正常挂起（`suspendedAsk`），交给 TUI 显示审批面板
4. 用户选择后 `resolveApprovalAsk` 处理结果，恢复工具循环

`ToolGate.asBeforeToolExecute()` 是 Gate→ToolPreflight 的参考桥接实现，但 Session 使用自己的 `_beforeToolExecute`（额外处理 artifacts-dir bypass 和 hooks）。

## 不变量

- `PermissionAdvisor` 是 Session 构造时唯一被 `addAdvisor` 进 `toolGate` 的 advisor。每个工具调用必过它。
- `safePath` 是另一道闸（在 executor 内），管路径越界。读操作（read/list/search/attach）不受路径边界限制，可以访问项目外的文件。写操作仍然受边界约束。Permission 管"动作类型"，safePath 管"作用域"，两者正交。
- 子代理的 `permissionMode` 永远跟父 session 一致（`Session.permissionMode` setter 会级联到所有 children）。
