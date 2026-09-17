import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(command, args, cwd = process.cwd()) {
  console.log(`$ ${command} ${args.join(' ')}`);
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const expectedVersion = packageJson.version;
const packageName = packageJson.name;
const tempDir = mkdtempSync(join(tmpdir(), 'nexum-package-check-'));
let tarball;

try {
  const packed = JSON.parse(run('npm', ['pack', '--json']))[0];
  if (!packed?.filename) throw new Error('npm pack did not return an artifact filename');

  tarball = join(root, packed.filename);
  run('npm', ['init', '-y'], tempDir);
  run('npm', ['install', '--ignore-scripts', tarball], tempDir);

  const installedVersion = run(
    'node',
    ['-e', `process.stdout.write(require('./node_modules/${packageName}/package.json').version)`],
    tempDir,
  ).trim();
  if (installedVersion !== expectedVersion) {
    throw new Error(`Installed package version ${installedVersion} does not match ${expectedVersion}`);
  }

  const cli = join(tempDir, 'node_modules', packageName, 'bin', 'cli.js');
  const version = run('node', [cli, '--version'], tempDir).trim();
  if (!version.includes(expectedVersion)) {
    throw new Error(`Unexpected CLI version: ${version}`);
  }

  run('node', [cli, '--help'], tempDir);

  const smoke = [
    `import * as pkg from '${packageName}';`,
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
  if (tarball) unlinkSync(tarball, { force: true });
}