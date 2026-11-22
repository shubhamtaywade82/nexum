---
layout: home

hero:
  name: "⚡ Nexum"
  text: "Open-Source Agent Runtime for Autonomous Software Engineering"
  tagline: "Local-first Ollama models, Docker sandboxing, 14 LSP language servers, offline DevDocs FTS5, and parallel DAG planning. Stable since 2.0.0."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: Architecture
      link: /guide/architecture
    - theme: alt
      text: Migration to 2.0.0
      link: /MIGRATION-2.0
    - theme: alt
      text: Tool Reference
      link: /guide/tools

features:
  - icon: 🛡️
    title: Docker-Sandboxed Execution
    details: Shell actions run in an isolated Linux container with --network=none, bounded CPU/RAM, and strict output ceilings.
  - icon: 🧠
    title: Two-Tier Capability Router
    details: Fast local models handle rapid turns; self-escalates seamlessly to cloud reasoning models for complex tasks.
  - icon: 🔍
    title: 14 Language Server Protocols
    details: Native IDE-grade definitions, references, hover, diagnostics, and symbols for TypeScript, Python, Rust, Go, Java, and more.
  - icon: 📚
    title: Offline DevDocs Search
    details: Embedded SQLite FTS5 index covering 25+ programming languages, frameworks, and machine learning libraries.
  - icon: 📋
    title: Parallel DAG Orchestrator
    details: Decomposes tasks into dependency graphs, executes independent steps concurrently, and detects infinite loops.
  - icon: 💾
    title: Memory & Crash Recovery
    details: Atomic step checkpoints and SQLite episode recording allow seamless session resumption without data loss.
  - icon: 🧭
    title: API Stability Tiers
    details: Tier 1 exports follow semver with a frozen contract since 2.0.0; Tier 2 is clearly-marked Experimental so you always know what you can depend on.
  - icon: 🔐
    title: Security & Trust Model
    details: Assume the model can be steered by anything it reads. Boundaries are designed for isolation — sandboxing, workspace guards, fenced tool output, and attestation.
---
