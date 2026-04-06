# Vigil

<p align="center">
  <strong>探索 Agent 自治。</strong>
</p>
<p align="center">
  <a href="./README.md">English</a> | 中文
</p>
<p align="center">
  <a href="https://felixruigao.github.io/LongerAgent/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

LongerAgent 是一个基于 OpenTUI 的 TUI Demo，探索一种设计哲学：如果系统只提供工具和安全兜底，让 Agent 主动管理自己的上下文和工作流，会怎样？

并行子 Agent 调查代码架构、运行中发送异步消息、上下文压缩——一个会话内完成：

https://github.com/user-attachments/assets/377fe648-d43c-45da-b111-9434b2a0dc61

---

## 试一试

```bash
npm install -g longer-agent
longeragent init
longeragent
```

配置向导会引导你完成 provider 选择（Anthropic、OpenAI、Kimi、MiniMax、GLM、Ollama、oMLX、LM Studio、OpenRouter）和模型选择。

> **平台：** macOS。 **安全提示：** LongerAgent 不对 shell 命令或文件编辑做沙箱隔离。请在可信环境中使用，并留意它的实际操作。

### CLI

```text
longeragent                     # 使用自动检测的配置启动
longeragent init                # 运行配置向导
longeragent oauth               # 通过 OAuth 登录 OpenAI（设备码 / 浏览器）
longeragent oauth status        # 查看 OAuth 登录状态
longeragent oauth logout        # 登出
longeragent --templates <path>  # 使用指定模板目录
longeragent --verbose           # 启用调试日志
longeragent --version           # 显示当前版本
```

### 命令

| 命令 | 说明 |
|------|------|
| `/model` | 运行时切换已配置的模型；可为托管 provider 补 key |
| `/mcp` | 按需连接已配置的 MCP server 并列出已发现工具 |
| `/thinking` | 控制每个模型的思考/推理深度 |
| `/skills` | 勾选启用/禁用技能 |
| `/resume` | 从日志恢复之前的会话 |
| `/summarize` | 压缩较早的上下文片段以释放空间 |
| `/compact` | 全量上下文重置，附带延续摘要 |

---

## 设计理念

### Agent 驱动的上下文管理

LongerAgent 给 Agent 提供工具来检视自身上下文分布（`show_context`）并蒸馏它自己选择的部分（`distill_context`）。每个对话片段内部都标记了唯一 ID 和 token 成本注解，让 Agent 能做出理性的成本收益决策。系统只在最后关头作为安全兜底介入。

三层机制协同工作：提示压缩在早期推动 Agent 主动压缩，Agent 主导的精确压缩给予它精细控制，自动 compact 兜住漏网之鱼。

### 并行子 Agent

Agent 不必按顺序做所有事，它可以 spawn 子 Agent——每个拥有独立的上下文窗口和工具访问权——并行探索或执行。三个内置模板（`main`、`explorer`、`executor`）限定每个子 Agent 的能力范围。结果汇报给主 Agent 进行综合。

### 可打断执行

你可以随时输入消息——即使 Agent 正在执行任务。消息排队等待，在下一个激活边界送达。不用等，不用重开。

### 持久记忆

两个 `AGENTS.md` 文件（全局和项目级）以及 Important Log 跨会话、跨上下文重置保留。Agent 读取它们维持连续性，也写入它们保存长期知识。

## 实际使用感受

LongerAgent 重点优化的是这样一条工作流：

1. 直接开始做真实任务，而不是演示型 prompt。
2. 让 Agent 连续探索、修改、测试一段时间。
3. 中途随时插话补充要求，不需要重新开局。
4. 通过 summarize 或 compact 维持会话寿命，而不是上下文一满就从头再来。

这个组合本身，才是 Demo 的核心，而不只是某一个命令或工具。

## 进一步了解

- **[设计哲学详解](https://felixruigao.hashnode.dev/exploring-agent-autonomy-building-a-coding-cli-that-manages-its-own-context)** —— 这个 Demo 背后的设计思考
- **[文档站](https://felixruigao.github.io/LongerAgent/)** —— 上下文管理、子 Agent、Skills、Provider 等完整指南

---

<details>
<summary><strong>参考</strong></summary>

### 支持的 Provider

| Provider | 模型 | 鉴权方式 |
|----------|------|----------|
| **Anthropic** | Claude Haiku 4.5、Opus 4.6、Sonnet 4.6（含 1M 上下文变体） | `ANTHROPIC_API_KEY` |
| **OpenAI** | GPT-5.2、GPT-5.2 Codex、GPT-5.3 Codex、GPT-5.4 | `OPENAI_API_KEY` 或 OAuth |
| **Kimi / Moonshot** | Kimi K2.5、K2 Instruct（国际、国内、Coding Plan\*） | LongerAgent 托管槽位（`LONGERAGENT_KIMI_*`）；配置时检测 `MOONSHOT_API_KEY` 和 `KIMI_*` |
| **MiniMax** | M2.1、M2.5（国际、国内） | LongerAgent 托管槽位（`LONGERAGENT_MINIMAX_*`）；配置时检测 `MINIMAX_*` |
| **GLM / 智谱** | GLM-5、GLM-4.7（国际、国内、Coding Plan） | LongerAgent 托管槽位（`LONGERAGENT_GLM_*`）；配置时检测 `GLM_*` |
| **Ollama** | 任意本地 Ollama 模型（动态发现） | — |
| **oMLX** | 任意本地 MLX 模型（动态发现） | — |
| **LM Studio** | 任意本地 GGUF 模型（动态发现） | — |
| **OpenRouter** | Claude、GPT、Kimi、MiniMax、GLM 预设，及任意自定义模型 | `OPENROUTER_API_KEY` |

> \* **Kimi Coding Plan 说明：** `kimi-code` 端点（`api.kimi.com/coding/v1`）目前被 Moonshot 限制为白名单 Agent，可能会收到 `403 Kimi For Coding is currently only available for Coding Agents` 错误。请改用 `kimi` 或 `kimi-cn`（标准 API）。

### 工具

**13 个内置工具：**

`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `time` · `web_search` · `web_fetch`

`read_file` 在多模态模型上支持图片文件（PNG、JPG、GIF、WebP 等）——Agent 可以直接查看和分析图片。

**8 个编排工具：**

`spawn` · `spawn_file` · `kill_agent` · `check_status` · `wait` · `show_context` · `distill_context` · `ask`

**Skills 系统** —— 将可复用的技能定义加载为动态 `skill` 工具。通过 `/skills` 管理（勾选启用/禁用）。技能每轮自动发现——安装或移除技能目录后立即生效，无需手动重载。内置 `skill-manager` 可教 Agent 自主搜索、下载和安装新技能。

**MCP 集成** —— 连接 Model Context Protocol 服务器以扩展工具。可用 `/mcp` 在第一轮对话前主动验证 server 配置并查看工具列表。

### 配置

```text
~/.longeragent/
├── tui-preferences.json   # 模型选择、本地 provider 配置、偏好（自动管理）
├── .env                   # API 密钥与托管 provider 槽位（0600 权限）
├── mcp.json               # MCP 服务器配置（可选，手动编辑）
├── auth.json              # OAuth token（自动管理）
├── agent_templates/       # 用户模板覆盖
├── skills/                # 用户技能
└── prompts/               # 用户 Prompt 覆盖
```

### 架构

LongerAgent 围绕 **Session → Agent → Provider** 流水线构建：

- **Session** 编排 turn 循环、消息投递、压缩、子 Agent 生命周期
- **Session Log** 是唯一事实来源——20+ 种条目类型记录所有运行时事件；TUI 显示和 Provider 输入都是同一数据的投影
- **Agent** 将模型 + 系统 Prompt + 工具封装为可复用的执行单元
- **Provider** 适配器在 10 个 Provider 间统一流式输出、推理、工具调用和用量

</details>

<details>
<summary><strong>开发</strong></summary>

```bash
pnpm install        # 安装依赖
pnpm dev            # 运行当前使用的 OpenTUI 开发界面
pnpm build          # 构建
pnpm test           # 运行测试（vitest）
pnpm typecheck      # 类型检查
```

</details>

## 许可证

[MIT](./LICENSE)
