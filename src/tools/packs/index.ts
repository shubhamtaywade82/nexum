/**
 * Tool packs (review item 21) — the mountable units AgentToolManager
 * composes, replacing its single large registration method.
 *
 *   FilesystemPack   workspace files + CAS editing + search
 *   ProcessPack      sandboxed shell + docker + test/lint/format/build
 *   GitPack          local git
 *   GitHubPack       GitHub API (external mutation)
 *   LspPack          language-server code intelligence
 *   BrowserPack      browser automation
 *   DocsPack         workspace docs
 *   TradingPack      market data + backtesting + paper trading
 *   RubyPack         RuboCop + RSpec (ruby domain)
 *   RailsPack        semantic Rails queries (rails domain)
 *   DatabasePack     sqlite queries
 *   AgentCorePack    escalate / delegate / ask-user
 *   MemoryPack       semantic long-term memory (save / recall)
 *
 * Legacy compat factories (shellPack, dockerPack, projectPack, cryptoPack,
 * gitGithubPack) remain exported.
 */

export { filesystemPack, searchPack } from "./filesystem-pack.js";
export {
  processPack,
  shellPack,
  dockerPack,
  projectPack,
  type ProcessPackOptions,
  type PackShellOutput,
} from "./process-pack.js";
export { gitPack, githubPack, gitGithubPack } from "./git-pack.js";
export { lspPack } from "./lsp-pack.js";
export { browserPack } from "./browser-pack.js";
export { docsPack } from "./docs-pack.js";
export { tradingPack, cryptoPack, type TradingPackOptions } from "./trading-pack.js";
export { rubyPack } from "./ruby-pack.js";
export { railsPack } from "./rails-pack.js";
export { databasePack } from "./database-pack.js";
export { agentCorePack } from "./agent-core-pack.js";
export { memoryPack } from "./memory-pack.js";
