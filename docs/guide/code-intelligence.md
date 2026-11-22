# 14 Language Server Protocols (LSP)

Nexum integrates directly with the Language Server Protocol (LSP) to provide true semantic code understanding across 14 programming languages.

---

## Supported Languages & Servers

| Language                    | LSP Server                   | Binary / Command                     |
| :-------------------------- | :--------------------------- | :----------------------------------- |
| **TypeScript / JavaScript** | `typescript-language-server` | `typescript-language-server --stdio` |
| **Python**                  | `pyright` / `pylsp`          | `pyright-langserver --stdio`         |
| **Go**                      | `gopls`                      | `gopls`                              |
| **Rust**                    | `rust-analyzer`              | `rust-analyzer`                      |
| **Ruby**                    | `ruby-lsp`                   | `ruby-lsp`                           |
| **Java**                    | `jdtls`                      | `jdtls`                              |
| **C#**                      | `OmniSharp` / `csharp-ls`    | `csharp-ls`                          |
| **C / C++**                 | `clangd`                     | `clangd`                             |
| **PHP**                     | `intelephense`               | `intelephense --stdio`               |
| **Swift**                   | `sourcekit-lsp`              | `sourcekit-lsp`                      |
| **Kotlin**                  | `kotlin-language-server`     | `kotlin-language-server`             |
| **Dart**                    | `dart analysis-server`       | `dart language-server`               |
| **YAML**                    | `yaml-language-server`       | `yaml-language-server --stdio`       |
| **Docker**                  | `dockerfile-language-server` | `docker-langserver --stdio`          |

---

## Graceful Fallback

If an LSP binary is not installed on the system, Nexum gracefully falls back to fuzzy AST and ripgrep text matching, ensuring the turn succeeds without error.
