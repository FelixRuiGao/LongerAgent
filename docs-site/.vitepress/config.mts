import { defineConfig } from "vitepress";

export default defineConfig({
  title: "LongerAgent",
  description: "A terminal AI coding agent built for long sessions",
  base: "/LongerAgent/",
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Providers", link: "/providers/" },
      { text: "Configuration", link: "/configuration" },
      {
        text: "GitHub",
        link: "https://github.com/FelixRuiGao/LongerAgent",
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
          { text: "ChatGPT OAuth Login", link: "/providers/openai-oauth" },
        ],
      },
      {
        text: "Guide",
        items: [
          { text: "Model Switching", link: "/guide/model-switching" },
          { text: "Context Management", link: "/guide/context" },
          { text: "Sub-Agents", link: "/guide/sub-agents" },
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
        link: "https://github.com/FelixRuiGao/LongerAgent",
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
