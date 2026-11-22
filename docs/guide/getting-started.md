# Getting Started

**Nexum** is an autonomous, developer-focused AI coding assistant designed to run local-first with Ollama, with failover to cloud reasoning models.

---

## Prerequisites

- **Node.js**: `v22.0.0` or higher
- **Ollama**: Local instance running on `http://localhost:11434` (or `OLLAMA_API_KEY` for cloud)
- **Docker**: For sandboxed execution of shell commands

---

## Installation

### 1. Global Installation (Recommended)

Install globally from npm:

```bash
npm install -g @nemesis-oss/nexum
```

### 2. From Source

```bash
git clone https://github.com/shubhamtaywade82/nexum.git
cd nexum
npm install
npm run build
npm link --force
```

---

## Building the Docker Sandbox

Nexum isolates command execution inside a secure container. Build the sandbox image:

```bash
docker build -t nexum-sandbox:latest docker/nexum-sandbox/
```

---

## Running Nexum

Navigate to any project directory and launch Nexum:

```bash
nexum
```

### Quick Commands inside TUI

- `Ctrl+M`: Open Model Switcher
- `Ctrl+P`: Open Universal Command Palette
- `/doctor`: Verify Ollama, models, language servers, and sandbox health
- `/plan <task>`: Plan and autonomously execute a multi-step objective
- `/help`: Open interactive cheat sheet
