# frozen_string_literal: true

require "optparse"

module CiHealer
  # Exit codes: 0 ok (including kill switch and lock contention), 1 tick failed
  # (retry next run), 2 configuration or ledger problem (operator action needed).
  module CLI
    module_function

    def main(argv, log: Log.new, shell: Shell.new, out: $stdout)
      options = parse(argv)
      config = Config.load(options.fetch(:config))

      if File.exist?(config.kill_switch_file)
        log.warn("kill switch present; not running", path: config.kill_switch_file)
        return 0
      end

      healer = build_healer(config, shell, log)
      if options[:dry_run]
        healer.plan(Ledger.load(config.state_file)).each { |line| out.puts(line) }
        return 0
      end

      Ledger.with_lock(config.state_file) { |ledger| healer.tick(ledger) }
      0
    rescue LockHeld => e
      log.info("skipping tick", reason: e.message)
      0
    rescue ConfigError, StateError => e
      log.error("fatal configuration or state problem", error: e.message)
      2
    rescue Error => e
      log.error("tick failed", error: e.message)
      1
    end

    def parse(argv)
      options = { dry_run: false }
      parser = OptionParser.new do |opts|
        opts.banner = "usage: ci-healer --config PATH [--dry-run]"
        opts.on("-c", "--config PATH", "JSON config file") { |value| options[:config] = value }
        opts.on("--dry-run", "Report what would happen; write nothing and push nothing") { options[:dry_run] = true }
      end
      parser.parse!(argv)
      raise ConfigError, parser.banner unless options[:config]

      options
    rescue OptionParser::ParseError => e
      raise ConfigError, "#{e.message}\n#{parser&.banner}"
    end

    def build_healer(config, shell, log)
      github = GitHub.new(shell: shell, slug: config.repo_slug, cwd: config.repo_dir)
      git = Git.new(shell: shell, repo_dir: config.repo_dir, author: config.git_author, log: log)
      nexum = NexumClient.new(command: config.nexum_command, timeout: config.nexum_timeout_sec, log: log,
                              env: AgentEnv.agent(ENV, allow: config.agent_env_allow))
      logs = LogSource.new(github: github, digester: Digester.new, log: log,
                           condenser: build_condenser(config.condenser), byte_cap: config.log_byte_cap)
      Healer.new(config: config, github: github, git: git, nexum: nexum, logs: logs, shell: shell, log: log)
    end

    def build_condenser(settings)
      case settings["type"]
      when "deterministic" then nil
      when "ollama"
        OllamaCondenser.new(url: settings.fetch("url", "http://127.0.0.1:11434"),
                            model: settings.fetch("model"), timeout: settings.fetch("timeout_sec", 60))
      end
    end
  end
end
