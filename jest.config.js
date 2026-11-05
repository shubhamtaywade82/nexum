import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// `npm test` sets NEXUM_TEST_NO_GLOBAL, but that only isolated the trust store:
// config and global skills still came from the developer's real ~/.nexum, so
// results depended on whose machine ran them. This runs in Jest's parent
// process; setting HOME from a setup file would not reach the native
// os.homedir(), because each test file gets a copy of process.env.
if (process.env.NEXUM_TEST_NO_GLOBAL) {
  // Playwright finds its browsers under the real home; keep the browser tests running.
  const browserCache = [".cache", join("Library", "Caches")]
    .map((dir) => join(homedir(), dir, "ms-playwright"))
    .find((dir) => existsSync(dir));
  if (browserCache && !process.env.PLAYWRIGHT_BROWSERS_PATH) process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;

  const home = mkdtempSync(join(tmpdir(), "nexum-test-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
}

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  setupFiles: ["<rootDir>/tests/jest.setup.js"],
  testTimeout: 30_000,
  // Ink's React reconciler can leave async handles open after tests finish;
  // forceExit ensures the Jest process exits cleanly.
  forceExit: true,
  extensionsToTreatAsEsm: [".ts", ".tsx"],
  // Source imports use explicit .js extensions (required for the real ESM
  // build); strip them back off so Jest's resolver finds the .ts source.
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    // Include .js so the setup file (which uses ESM import) is transformed
    // through ts-jest instead of being loaded raw, which fails under
    // --experimental-vm-modules when setupFiles doesn't go through transforms.
    "^.+\\.(tsx?|js)$": [
      "ts-jest",
      {
        useESM: true,
        // Transpile-only: type errors from the @jest/globals vs @types/jest
        // ambient-type overlap (see tests/jest.setup.js) shouldn't block test
        // execution — `tsc --noEmit` on the real tsconfig is the actual type
        // gate (see package.json build/lint scripts), this is just runtime.
        // isolatedModules is set in tsconfig.json's compilerOptions (ts-jest v30
        // moved it there from this transform option, which is now deprecated).
        diagnostics: {
          ignoreCodes: [151002],
        },
      },
    ],
  },
};
