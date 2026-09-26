import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/nexum/",
  title: "⚡ Nexum",
  description: "Open-Source Agent Runtime & Harness for Autonomous Software Engineering",
  lastUpdated: true,
  cleanUrls: true,
  srcExclude: [
    "**/superpowers/**",
    "**/REBRANDING.md",
    "**/requirements/**",
    "**/plan/**",
    "SPEC.md",
    "FEATURE_VERIFICATION_GUIDE.md",
    "deep-research-report.md",
    "tui-capability-spec.md",
  ],
  themeConfig: {
    siteTitle: "⚡ Nexum",
    nav: [
      { text: "Home", link: "/" },
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Architecture", link: "/guide/architecture" },
      { text: "Kernel", link: "/guide/kernel" },
      { text: "Tools", link: "/guide/tools" },
      { text: "Benchmarks", link: "/guide/benchmarks" },
      { text: "GitHub", link: "https://github.com/nemesis-oss/nexum" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Configuration & Diagnostics", link: "/guide/configuration" },
          { text: "Terminal UI & Keybindings", link: "/guide/tui" },
        ],
      },
      {
        text: "Core Architecture",
        items: [
          { text: "System Architecture", link: "/guide/architecture" },
          { text: "Agent Execution Kernel", link: "/guide/kernel" },
          { text: "Capability Router & Escalation", link: "/guide/capability-routing" },
          { text: "DAG Planner & Parallel Execution", link: "/guide/planner" },
          { text: "Docker Sandboxing", link: "/guide/sandboxing" },
        ],
      },
      {
        text: "Code Intelligence & Memory",
        items: [
          { text: "14 Language Server Protocols (LSP)", link: "/guide/code-intelligence" },
          { text: "Offline DevDocs Search", link: "/guide/devdocs" },
          { text: "Rails Semantic AST Index", link: "/guide/rails" },
          { text: "Persistent Memory & Learning", link: "/guide/memory" },
          { text: "Semantic Memory", link: "/guide/semantic-memory" },
          { text: "Agentic RAG (Hybrid Retrieval)", link: "/guide/rag" },
        ],
      },
      {
        text: "Evaluation & Quality",
        items: [
          { text: "Agent Evaluation Framework", link: "/guide/evaluation" },
          { text: "LLM-as-a-Judge", link: "/guide/llm-judge" },
          { text: "In-Loop Critic & Self-Correction", link: "/guide/critic" },
        ],
      },
      {
        text: "Multi-Agent & Production",
        items: [
          { text: "Multi-Agent Coordination", link: "/guide/multiagent" },
          { text: "Artifacts", link: "/guide/artifacts" },
          { text: "Telemetry (OpenTelemetry)", link: "/guide/telemetry" },
          { text: "Durable Job Queue", link: "/guide/durable-jobs" },
        ],
      },
      {
        text: "Extensibility & Reference",
        items: [
          { text: "35+ Built-in Tools Reference", link: "/guide/tools" },
          { text: "Model Context Protocol (MCP)", link: "/guide/mcp" },
          { text: "Custom Skills & Prompts", link: "/guide/skills" },
          { text: "Model Benchmark Harness", link: "/guide/benchmarks" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/nemesis-oss/nexum" },
      { icon: "npm", link: "https://www.npmjs.com/package/@nemesis-oss/nexum" },
    ],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Nemesis OSS & Shubham Taywade",
    },
  },
});
