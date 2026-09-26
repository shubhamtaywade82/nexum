#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [command] = process.argv.slice(2);

if (command === '--version' || command === '-v') {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  console.log(`${pkg.name} v${pkg.version}`);
  process.exit(0);
}

if (command === '--help' || command === '-h') {
  console.log(`
Nexum — Autonomous Software Engineering Agent Runtime & Workspace

Usage:
  nexum                         Launch interactive terminal workspace
  nexum "<task>"                Start a mission for the specified task
  nexum fix "<issue>"           Investigate, plan, implement, and verify fix
  nexum issue <number>          Resolve GitHub issue end-to-end and prepare PR
  nexum rpc                     Start JSON-RPC agent server over stdio
  nexum doctor                  Run system, workspace, and model diagnostics
  nexum migrate                 Migrate legacy .devagent state to .nexum
  nexum asl [validate|graph]    Architecture definition commands
  nexum evolve [options]        Harness evolution and self-development commands
  nexum plugins sandbox <file>  Trial-run a plugin in the worker sandbox
  nexum plugins verify [id…]    Re-verify installed marketplace plugins
  nexum marketplace keys …      Publisher trust store management
  nexum mcp trust …             MCP server trust approvals & policy preview
  nexum credentials …           Credential resolution preview (redacted)
  nexum capabilities …          Capability attestation authority & ledger

Options:
  -h, --help                    Show this help message
  -v, --version                 Show version
`);
  process.exit(0);
}

if (command === 'doctor') {
  const { runDoctor } = await import('../dist/cli/doctor.js');
  const report = await runDoctor();
  console.log('=== Nexum Doctor ===');
  console.log(report.lines.join('\n'));
  process.exit(report.ok ? 0 : 1);
}

if (command === 'evolve') {
  const { runEvolutionCli } = await import('../dist/evolution/cli.js');
  await runEvolutionCli(process.argv.slice(3));
  process.exit(0);
}

// Trust & security command areas (plugins / marketplace / mcp / credentials /
// capabilities). Everything else falls through to the interactive UI.
if (['plugins', 'marketplace', 'mcp', 'credentials', 'capabilities'].includes(command)) {
  const { runSecurityCli } = await import('../dist/cli/security.js');
  const code = await runSecurityCli(command, process.argv.slice(3));
  process.exit(code);
}

if (command === 'rpc') {
  const { main } = await import('../dist/cli/rpc.js');
  await main(process.argv.slice(3));
  // The RPC server blocks on stdin; exit happens via the stdin 'end' handler.
  process.exit(0);
}

if (command === 'migrate') {
  const { main } = await import('../dist/cli/migrate.js');
  await main(process.argv.slice(3));
} else {
  await import('../dist/ui/index.js');
}
