# Fermi

<p align="center">
  <strong>能自主压缩上下文的编程 Agent。</strong>
</p>
<p align="center">
  <a href="./README.md">English</a> | 中文
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/fermi-code"><img alt="npm" src="https://img.shields.io/npm/v/fermi-code?style=flat-square" /></a>
  <a href="https://felixruigao.github.io/Fermi/"><img alt="Docs" src="https://img.shields.io/badge/docs-website-4b4bf0?style=flat-square" /></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" /></a>
</p>

<!-- MEDIA: 主截图 — TUI 工作中，展示上下文注解 -->

Fermi 是一个为长时间会话设计的终端 AI 编程 Agent。Agent 能审视自身的上下文窗口，判断哪些信息仍有价值，然后精确压缩其余部分——粒度细到单个 tool call 的结果。会话持续运行数小时；关键决策、文件路径、未解决问题不会丢失。

> **平台：** macOS（Apple Silicon）。**许可证：** MIT。

## 安装

```bash
bun install -g fermi-code
fermi init      # 配置向导 — 选择 provider、模型、API key
fermi           # 开始会话
```

需要 [Bun](https://bun.sh) 1.3+。

## 上下文管理

核心特性。Agent 拥有两个工具来审视和压缩自身上下文：

| 工具 | 功能 |
|------|------|
| `show_context` | 展示上下文分布图 — 所有分组的 token 大小、类型和内联注解 |
| `summarize` | 压缩选定的上下文分组 — 提取决策和事实，丢弃其余 |

用户也可以直接介入：

| 命令 | 功能 |
|------|------|
| `/summarize` | 交互式范围选择器 — 选择起止 turn，输入可选的保留指令 |
| `/compact` | 全量上下文重置，生成延续摘要 |

<!-- MEDIA: 双面板对比 — 左: /summarize 交互式选择器；右: Agent 自主调用 show_context → summarize -->

三层机制防止上下文悄然溢出：

```
上下文用量 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 100%
              ▲ 60%            ▲ 80%       ▲ 85%    ▲ 90%
              提示 L1          提示 L2     compact   compact
              (引导压缩)        (紧急)     (turn前)   (turn中)
```

[完整上下文管理指南 →](https://felixruigao.github.io/Fermi/guide/context)

## 子 Agent

Agent 自主创建拥有独立上下文窗口的并行工作者：

```
spawn(id="auth-check", template="explorer", mode="oneshot", model_level="low", task="...")
```

- **模板：** `explorer`（只读）、`executor`（执行任务）、`reviewer`（验证结果）
- **模型分级：** 通过 `/tier` 指定高/中/低三档模型 — 简单任务用便宜模型
- **模式：** `oneshot`（执行一次返回结果）或 `persistent`（常驻，接收后续消息）

## 会话控制

- **异步消息** — Agent 工作时随时输入。消息排队，在 Agent 两次动作之间投递。
- **回退** — `/rewind` 回退到任意之前的 turn，同时恢复对话状态**和**文件变更。
- **分叉** — `/fork` 将当前会话分支到新方向。
- **持久记忆** — `AGENTS.md` 文件（全局 + 项目级）在 compact 和会话重启后保留。

---

## Provider

Anthropic · OpenAI · GitHub Copilot · DeepSeek · Kimi · MiniMax · GLM · 小米 · OpenRouter · Ollama · oMLX · LM Studio

云端或本地，随意选择。运行时用 `/model` 切换。`fermi init` 处理配置。

[Provider 配置指南 →](https://felixruigao.github.io/Fermi/providers/)

## 主要命令

`/model` 切换模型 · `/summarize` 压缩上下文 · `/compact` 全量重置 · `/rewind` 回退 turn + 文件 · `/permission` 安全模式 · `/tier` 子 Agent 模型分级 · `/session` 恢复会话 · `/fork` 分叉会话 · `/skills` 管理技能 · `/mcp` MCP 工具

[完整命令参考 →](https://felixruigao.github.io/Fermi/guide/commands)

## 已知限制

- **仅支持 macOS + Apple Silicon** — 不支持 Windows 和 Linux
- **无沙箱** — shell 命令和文件编辑直接执行（用 `/permission` 控制权限级别）
- **第三方编程套餐**（Kimi-Code、GLM-Code）使用服务商侧白名单，可能拒绝请求

完整文档：**[felixruigao.github.io/Fermi](https://felixruigao.github.io/Fermi/)**

## 界面

- **终端（TUI）** — 主要界面，基于 [OpenTUI](https://github.com/anomalyco/opentui) 构建。运行 `fermi` 或 `bun run dev`。
- **桌面端（GUI）** — Electron 应用，早期开发中（`gui/`）。同一运行时，不同前端。

## 开发

```bash
bun install         # 安装依赖
bun run dev         # 运行 TUI（OpenTUI）
bun run build       # 构建二进制
bun test            # 运行测试
bun run typecheck   # 类型检查
```

## 许可证

[MIT](./LICENSE)。TUI 使用 [OpenTUI](https://github.com/anomalyco/opentui)（MIT）。
