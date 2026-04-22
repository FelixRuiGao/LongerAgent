# Vigil

<p align="center">
  <strong>用更短的上下文完成更多工作。</strong>
</p>
<p align="center">
  <a href="./README.md">English</a> | 中文
</p>
<p align="center">
  <a href="https://felixruigao.github.io/LongerAgent/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
  <img alt="Author" src="https://img.shields.io/badge/author-Felix%20Rui%20Gao-4b4bf0?style=flat-square" />
</p>

> ## ⚠️ 正在进行大规模重构（v0.2.0）
>
> Vigil 正在重写发布流程与 runtime 边界。**此版本与 `0.1.x` 不向后兼容** —— 配置文件布局、entry point 与最低环境要求都已变化。

Vigil 是一个终端 AI 编程 Agent，尝试用更少的上下文发挥出模型的最大潜能。它遵循 **Explore → Plan → Execute → Review** 工作流，支持可相互交流的 Agent 团队，并让 Agent 自己使用工具总结、提炼它认为对后续任务不再重要的上下文（精确到单个 tool result）——让会话保持高效更长时间。

TUI 基于 [OpenTUI](https://github.com/anomalyco/opentui) 构建。

> **平台：** macOS（Apple Silicon）。需要 [Bun](https://bun.sh/) ≥ 1.1。**安全提示：** Vigil 不对 shell 命令或文件编辑做沙箱隔离。请在可信环境中使用，并留意它的实际操作。

## 安装

```bash
npm install -g vigil-code
vigil init
vigil
```

配置向导会引导你完成 provider 和模型选择。

### CLI

```text
vigil                       # 使用自动检测的配置启动
vigil init                  # 运行配置向导
vigil oauth                 # 通过 OAuth 登录 OpenAI（设备码 / 浏览器）
vigil oauth status          # 查看 OAuth 登录状态
vigil oauth logout          # 登出
vigil --templates <path>    # 使用指定模板目录
vigil --verbose             # 启用调试日志
vigil --version             # 显示当前版本
```

### 命令

| 命令 | 说明 |
|------|------|
| `/model` | 运行时切换已配置的模型 |
| `/mcp` | 按需连接已配置的 MCP server 并列出工具 |
| `/thinking` | 控制每个模型的思考/推理深度 |
| `/skills` | 勾选启用/禁用技能 |
| `/sessions` | 恢复之前的会话（别名：`/resume`） |
| `/summarize` | 压缩较早的上下文片段以释放空间 |
| `/compact` | 全量上下文重置，附带延续摘要 |
| `/codex` | OpenAI ChatGPT 登录 |
| `/copilot` | GitHub Copilot 登录 |
| `/agents` | 查看 Agent 列表 |
| `/rename` | 重命名当前会话 |
| `/raw` | 切换 Markdown 原始/渲染模式（别名：`/md`） |
| `/new` | 开始新会话 |

---

## 设计

### Explore → Plan → Execute → Review

Vigil 围绕四个阶段组织工作。主 Agent 探索问题空间，编写计划（`plan.md`，含检查点），spawn 执行子 Agent 完成工作，spawn 审查子 Agent 验证结果。每个阶段衔接下一个，保持工作流聚焦且可追溯。

### 可交流的 Agent 团队

子 Agent 不是孤立的工人——它们构成一个可以相互交流的团队。每个 Agent（explorer、executor、reviewer）拥有独立的上下文窗口和工具访问权，并行运行，向主 Agent 汇报结果。主 Agent 负责综合和协调。

### 上下文管理

Vigil 给 Agent 提供工具来检视自身上下文分布（`show_context`）并蒸馏它自己选择的部分（`distill_context`）。每个对话片段标记了唯一 ID 和 token 成本注解，让 Agent 能做出理性的成本收益决策。

三层机制协同工作：提示压缩在早期推动 Agent 主动压缩，Agent 主导的精确压缩给予精细控制，自动 compact 兜住漏网之鱼。

### 可打断执行

你可以随时输入消息——即使 Agent 正在执行任务。消息排队等待，在下一个激活边界送达。

### 持久记忆

两个 `AGENTS.md` 文件（全局和项目级）跨会话、跨上下文重置保留。Agent 读取它们维持连续性，也写入它们保存长期知识。

---

<details>
<summary><strong>参考</strong></summary>

### 支持的 Provider

| Provider | 鉴权方式 |
|----------|----------|
| **Anthropic** | `ANTHROPIC_API_KEY` |
| **OpenAI** | `OPENAI_API_KEY` 或 OAuth |
| **GitHub Copilot** | `/copilot` 登录 |
| **Kimi / Moonshot** | Vigil 托管槽位（`VIGIL_KIMI_*`） |
| **MiniMax** | Vigil 托管槽位（`VIGIL_MINIMAX_*`） |
| **GLM / 智谱** | Vigil 托管槽位（`VIGIL_GLM_*`） |
| **Ollama** | — |
| **oMLX** | — |
| **LM Studio** | — |
| **OpenRouter** | `OPENROUTER_API_KEY` |

### 工具

**13 个内置工具：**
`read_file` · `list_dir` · `glob` · `grep` · `edit_file` · `write_file` · `bash` · `bash_background` · `bash_output` · `kill_shell` · `time` · `web_search` · `web_fetch`

`read_file` 在多模态模型上支持图片文件（PNG、JPG、GIF、WebP）。

**8 个编排工具：**
`spawn` · `spawn_file` · `kill_agent` · `check_status` · `wait` · `show_context` · `distill_context` · `ask`

**Skills 系统** — 将可复用的技能定义加载为动态 `skill` 工具。通过 `/skills` 管理。技能每轮自动发现。内置 `skill-manager` 可教 Agent 自主搜索、下载和安装新技能。

**MCP 集成** — 连接 Model Context Protocol 服务器以扩展工具。可用 `/mcp` 查看已配置的服务器。

### 配置

```text
~/.vigil/
├── tui-preferences.json   # 模型选择、provider 配置、偏好
├── .env                   # API 密钥与托管 provider 槽位（0600 权限）
├── mcp.json               # MCP 服务器配置（可选）
├── state/
│   └── oauth.json         # OAuth token
├── agent_templates/       # 用户模板覆盖
├── skills/                # 用户技能
└── prompts/               # 用户 Prompt 覆盖
```

### 架构

Vigil 围绕 **Session → Agent → Provider** 流水线构建：

- **Session** 编排 turn 循环、消息投递、压缩、子 Agent 生命周期
- **Session Log** 是唯一事实来源——20+ 种条目类型记录所有运行时事件；TUI 显示和 Provider 输入都是同一数据的投影
- **Agent** 将模型 + 系统 Prompt + 工具封装为可复用的执行单元
- **Provider** 适配器在所有 Provider 间统一流式输出、推理、工具调用和用量

</details>

<details>
<summary><strong>开发</strong></summary>

```bash
pnpm install        # 安装依赖
pnpm dev            # 运行 TUI（OpenTUI）
pnpm build          # 构建
pnpm test           # 运行测试（vitest）
pnpm typecheck      # 类型检查
```

</details>

## 许可证

[MIT](./LICENSE)

TUI 基于 [OpenTUI](https://github.com/anomalyco/opentui)（MIT）构建。原始许可证见 [`opentui-src/forked/LICENSE.opentui`](opentui-src/forked/LICENSE.opentui)。
