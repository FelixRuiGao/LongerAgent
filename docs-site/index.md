---
layout: home

hero:
  name: Fermi
  text: The coding agent that compresses its own memory.
  tagline: Surgical context control lets a single session run for hours — no blind resets, no lost decisions.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/FelixRuiGao/Fermi

features:
  - title: Fine-Grained Context Control
    details: The agent sees the token cost of every context block and compresses what it chooses — even a single tool result. Three layers (hints → agent summarization → auto-compact) keep sessions alive for hours.
  - title: Async Messaging
    details: Type messages at any time, even mid-task. Messages queue and deliver when the agent pauses between actions. No waiting, no restart needed.
  - title: Sub-Agents with Model Tiers
    details: Spawn explorer, executor, and reviewer sub-agents — each with its own context window, running in parallel. Assign high/medium/low model tiers to balance cost and capability.
  - title: Rewind & Fork
    details: Roll back to any previous turn with /rewind — conversation and file system state revert together. Fork a session into a new branch with /fork.
  - title: Multi-Provider Support
    details: Anthropic, OpenAI, GitHub Copilot, DeepSeek, Kimi, MiniMax, GLM, Xiaomi, Ollama, oMLX, LM Studio, and OpenRouter.
  - title: Extensible via Skills & MCP
    details: Install reusable skill packages or connect MCP servers for additional tools. The agent discovers and uses them automatically.
---
