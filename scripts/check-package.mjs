import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'nexum-package-check-'));

function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  const packed = JSON.parse(run('npm', ['pack', '--json']))[0];
  if (!packed?.filename) throw new Error('npm pack did not return an artifact filename');

  const tarball = join(root, packed.filename);
  run('npm', ['init', '-y'], tempDir);
  run('npm', ['install', '--ignore-scripts', tarball], tempDir);

  const version = run('node', ['node_modules/@nemesis-oss/nexum/bin/cli.js', '--version'], tempDir).trim();
  if (!version.includes('2.0.0-alpha.2')) {
    throw new Error(`Unexpected CLI version: ${version}`);
  }

  run('node', ['node_modules/@nemesis-oss/nexum/bin/cli.js', '--help'], tempDir);

  const smoke = [
    "import * as pkg from '@nemesis-oss/nexum';",
    "const required = ['DefaultAgentRuntime','ReActStrategy','PlanExecuteStrategy','GraphStrategy','DefaultToolGateway','DefaultModelGateway','RulePolicyEngine','Agent','DevAgent','CryptoAgent'];",
    "for (const name of required) if (!(name in pkg)) throw new Error(`Missing public export: ${name}`);",
    "console.log('Public API smoke test passed');",
  ].join('\n');
  const smokeFile = join(tempDir, 'smoke.mjs');
  writeFileSync(smokeFile, smoke);
  run('node', [smokeFile], tempDir);

  console.log(`Package validation passed: ${packed.filename}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
