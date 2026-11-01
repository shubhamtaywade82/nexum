# frozen_string_literal: true

module CiHealer
  # Environment policy for every process the daemon starts on a repository's behalf.
  #
  # The daemon keeps GitHub and SSH credentials for its own gh/git calls. The agent
  # and repo-controlled commands (verify, setup) get an allowlisted environment, so a
  # test script or a prompt-injected agent cannot read `GH_TOKEN` from its env.
  #
  # Two policies, because they need different things:
  #   agent        model configuration (NEXUM_*, OLLAMA_*, including provider keys)
  #   repo_command no model configuration; repo code has no need for provider keys
  #
  # Both apply HARD_DENY last, so no allowlist entry can re-admit a GitHub or SSH
  # credential. Caveat: this blocks environment variables only. File-based credentials
  # under HOME (for example ~/.config/gh) are not covered by this policy.
  module AgentEnv
    COMMON_EXACT = %w[PATH HOME USER LOGNAME LANG TERM TMPDIR TZ].freeze
    COMMON_PREFIXES = %w[LC_].freeze
    AGENT_PREFIXES = %w[NEXUM_ OLLAMA_].freeze

    HARD_DENY = [
      /\A(GH|GITHUB|GITLAB|SSH|GPG)_/,
      /\AGIT_(ASKPASS|SSH|CONFIG|DIR|WORK_TREE|CREDENTIAL)/,
      /GITHUB/,
      /_AUTH_SOCK\z/
    ].freeze

    module_function

    def agent(source = ENV, allow: [])
      build(source, exact: COMMON_EXACT, prefixes: COMMON_PREFIXES + AGENT_PREFIXES, extra: allow)
    end

    def repo_command(source = ENV)
      build(source, exact: COMMON_EXACT, prefixes: COMMON_PREFIXES, extra: [])
    end

    def build(source, exact:, prefixes:, extra:)
      source.each_with_object({}) do |(key, value), env|
        next if hard_denied?(key)
        next unless exact.include?(key) || extra.include?(key) || prefixes.any? { |prefix| key.start_with?(prefix) }

        env[key] = value
      end
    end

    def hard_denied?(key)
      HARD_DENY.any? { |pattern| key.match?(pattern) }
    end
  end
end
