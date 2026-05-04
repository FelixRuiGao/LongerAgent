import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Fermi",
  description: "A terminal AI coding agent with surgical context management for multi-hour sessions",
  base: "/Fermi/",
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Providers", link: "/providers/" },
      { text: "Configuration", link: "/configuration" },
      {
        text: "GitHub",
        link: "https://github.com/FelixRuiGao/Fermi",
      },
    ],

    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/getting-started" },
        ],
      },
      {
        text: "Providers",
        items: [
          { text: "Overview", link: "/providers/" },
          { text: "Cloud Providers", link: "/providers/cloud" },
          { text: "Local Providers", link: "/providers/local" },
          { text: "GitHub Copilot", link: "/providers/copilot" },
          { text: "ChatGPT OAuth Login", link: "/providers/openai-oauth" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Context Management", link: "/guide/context" },
          { text: "Sub-Agents", link: "/guide/sub-agents" },
          { text: "Model Switching", link: "/guide/model-switching" },
          { text: "Permissions & Hooks", link: "/guide/permissions" },
          { text: "Skills", link: "/guide/skills" },
          { text: "MCP Integration", link: "/guide/mcp" },
          { text: "Tools Reference", link: "/guide/tools" },
          { text: "Slash Commands", link: "/guide/commands" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "Configuration", link: "/configuration" },
          { text: "FAQ", link: "/faq" },
        ],
      },
    ],

    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/FelixRuiGao/Fermi",
      },
    ],

    search: {
      provider: "local",
    },

    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright Felix Rui Gao",
    },
  },
});
