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
    "**/evolution/**",
    "SPEC.md",
    "FEATURE_VERIFICATION_GUIDE.md",
    "deep-research-report.md",
    "tui-capability-spec.md",
    // Release-process internals — kept in the repo, not published to the site:
    "API-FREEZE-AUDIT.md",
    "B6-TARBALL-AUDIT.md",
    "BRAND-AUDIT.md",
    "HARNESS_EVOLUTION.md",
    "ISSUE_AUTOMATION.md",
    "PRODUCTION_AUDIT.md",
    "SECURITY-AUDIT-MCP.md",
    "STABLE-RELEASE-HANDOFF.md",
    "WORKTREES.md",
    "server-protocol.md",
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
      { text: "Migration & Stability", link: "/MIGRATION-2.0" },
      { text: "GitHub", link: "https://github.com/shubhamtaywade82/nexum" },
    ],
    sidebar: [
      {
        text: "Introduction",
        items: [
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Configuration & Diagnostics", link: "/guide/configuration" },
          { text: "Terminal UI & Keybindings", link: "/guide/tui" },
          { text: "CLI Reference", link: "/guide/cli-reference" },
        ],
      },
      {
        text: "Stability & Migration",
        items: [
          { text: "Migration Guide — 2.0.0", link: "/MIGRATION-2.0" },
          {
            text: "API Stability Tiers",
            link: "https://github.com/shubhamtaywade82/nexum/blob/main/STABILITY.md",
          },
          {
            text: "Security & Trust Model",
            link: "https://github.com/shubhamtaywade82/nexum/blob/main/SECURITY.md",
          },
        ],
      },
      {
        text: "Core Architecture",
        items: [
          { text: "System Architecture", link: "/guide/architecture" },
          { text: "Agent Execution Kernel", link: "/guide/kernel" },
          { text: "Capability Router & Escalation", link: "/guide/capability-routing" },
          { text: "Decision Plane (System One)", link: "/guide/decision-plane" },
          { text: "Multi-Key Cloud Pools & Rotation", link: "/guide/model-keys" },
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
          { text: "Context Compiler & Verification Gate", link: "/guide/context-compiler" },
        ],
      },
      {
        text: "Multi-Agent & Production",
        items: [
          { text: "Artifacts", link: "/guide/artifacts" },
          { text: "Nexum Server Architecture", link: "/guide/server" },
          { text: "Telemetry (OpenTelemetry)", link: "/guide/telemetry" },
          { text: "Durable Job Queue", link: "/guide/durable-jobs" },
        ],
      },
      {
        text: "CI Healer",
        items: [
          { text: "Guide", link: "/guide/ci-healer" },
          { text: "Design", link: "/ci-healer/DESIGN" },
          { text: "Backlog", link: "/ci-healer/BACKLOG" },
        ],
      },
      {
        text: "Extensibility & Reference",
        items: [
          { text: "35+ Built-in Tools Reference", link: "/guide/tools" },
          { text: "Model Context Protocol (MCP)", link: "/guide/mcp" },
          { text: "MCP Elicitation", link: "/guide/mcp-elicitation" },
          { text: "Credentials & Secret Providers", link: "/guide/credentials" },
          { text: "Plugin Sandbox & Isolation", link: "/guide/plugin-sandbox" },
          { text: "Plugin Marketplace & Signing", link: "/guide/marketplace" },
          { text: "Capability Attestation", link: "/guide/attestations" },
          { text: "Trust & Security CLI", link: "/guide/security-cli" },
          { text: "Custom Skills & Prompts", link: "/guide/skills" },
          { text: "Model Benchmark Harness", link: "/guide/benchmarks" },
          { text: "Validation playbook", link: "/guide/validation" },
        ],
      },
    ],
    search: {
      provider: "local",
    },
    socialLinks: [
      { icon: "github", link: "https://github.com/shubhamtaywade82/nexum" },
      { icon: "npm", link: "https://www.npmjs.com/package/@nemesis-oss/nexum" },
    ],
    footer: {
      message: "Released under the MIT License.",
      copyright: "Copyright © 2026 Nemesis OSS & Shubham Taywade",
    },
  },
});
