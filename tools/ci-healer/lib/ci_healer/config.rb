# frozen_string_literal: true

require "json"

module CiHealer
  # Loads and validates the JSON config. Required safety invariants are enforced
  # here: at least one verify command must exist, so a patch can never be pushed
  # without local verification.
  class Config
    SLUG_RE = %r{\A[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\z}
    CONDENSER_TYPES = %w[deterministic ollama].freeze

    DEFAULTS = {
      "state_file" => "~/.local/share/ci-healer/state.json",
      "kill_switch_file" => "~/.local/share/ci-healer/DISABLED",
      "worktree_base" => "/tmp/ci-healer-worktrees",
      "nexum_command" => ["nexum"],
      "nexum_timeout_sec" => 1800,
      "setup_commands" => [],
      "setup_timeout_sec" => 900,
      "verify_timeout_sec" => 900,
      "max_heal_attempts_per_lineage" => 3,
      "max_heals_per_tick" => 1,
      "max_open_prs_per_base" => 1,
      "max_changed_files" => 10,
      "run_scan_limit" => 30,
      "log_byte_cap" => 2_000_000,
      "forbidden_paths" => [".github/workflows/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"],
      "git_author" => { "name" => "ci-healer", "email" => "ci-healer@localhost" },
      "condenser" => { "type" => "deterministic" },
      "agent_env_allow" => []
    }.freeze

    POSITIVE_INTEGER_KEYS = %w[
      nexum_timeout_sec setup_timeout_sec verify_timeout_sec log_byte_cap run_scan_limit
      max_heals_per_tick max_open_prs_per_base max_changed_files
    ].freeze

    SIMPLE_KEYS = %w[
      nexum_command nexum_timeout_sec setup_commands setup_timeout_sec verify_commands verify_timeout_sec
      max_heal_attempts_per_lineage max_heals_per_tick max_open_prs_per_base max_changed_files
      run_scan_limit log_byte_cap forbidden_paths git_author condenser agent_env_allow
    ].freeze

    SIMPLE_KEYS.each { |key| define_method(key) { @data[key] } }

    def self.load(path)
      raw = JSON.parse(File.read(File.expand_path(path)))
      new(raw)
    rescue Errno::ENOENT
      raise ConfigError, "config file not found: #{path}"
    rescue JSON::ParserError => e
      raise ConfigError, "config is not valid JSON (#{path}): #{e.message}"
    end

    def initialize(raw)
      raise ConfigError, "config must be a JSON object" unless raw.is_a?(Hash)

      @data = DEFAULTS.merge(raw)
      validate!
    end

    def repo_slug
      @data.dig("repo", "slug")
    end

    def repo_dir
      File.expand_path(@data.dig("repo", "dir"))
    end

    def repo_name
      repo_slug.split("/").last
    end

    def state_file
      File.expand_path(@data["state_file"])
    end

    def kill_switch_file
      File.expand_path(@data["kill_switch_file"])
    end

    def worktree_base
      File.expand_path(@data["worktree_base"])
    end

    private

    def validate!
      repo = @data["repo"]
      raise ConfigError, "repo must be an object with slug and dir" unless repo.is_a?(Hash)
      raise ConfigError, "repo.slug must look like owner/name" unless repo["slug"].is_a?(String) && repo["slug"].match?(SLUG_RE)
      raise ConfigError, "repo.dir is required" unless repo["dir"].is_a?(String)
      raise ConfigError, "repo.dir is not a git checkout: #{repo_dir}" unless File.exist?(File.join(repo_dir, ".git"))

      verify = @data["verify_commands"]
      unless non_empty_string_array?(verify)
        raise ConfigError, "verify_commands must be a non-empty array of strings: unverified patches are never pushed"
      end

      raise ConfigError, "nexum_command must be a non-empty array of strings" unless non_empty_string_array?(@data["nexum_command"])
      raise ConfigError, "setup_commands must be an array of strings" unless string_array?(@data["setup_commands"])
      raise ConfigError, "forbidden_paths must be an array of strings" unless string_array?(@data["forbidden_paths"])
      raise ConfigError, "agent_env_allow must be an array of strings" unless string_array?(@data["agent_env_allow"])

      POSITIVE_INTEGER_KEYS.each do |key|
        value = @data[key]
        raise ConfigError, "#{key} must be a positive integer" unless value.is_a?(Integer) && value.positive?
      end

      attempts = @data["max_heal_attempts_per_lineage"]
      raise ConfigError, "max_heal_attempts_per_lineage must be between 1 and 10" unless attempts.is_a?(Integer) && attempts.between?(1, 10)

      validate_author!
      validate_condenser!
    end

    def validate_author!
      author = @data["git_author"]
      return if author.is_a?(Hash) && %w[name email].all? { |k| author[k].is_a?(String) && !author[k].strip.empty? }

      raise ConfigError, "git_author needs non-empty name and email"
    end

    def validate_condenser!
      condenser = @data["condenser"]
      raise ConfigError, "condenser.type must be one of #{CONDENSER_TYPES.join(", ")}" unless condenser.is_a?(Hash) && CONDENSER_TYPES.include?(condenser["type"])
      return unless condenser["type"] == "ollama"
      raise ConfigError, "condenser.model is required for ollama" unless condenser["model"].is_a?(String) && !condenser["model"].empty?
    end

    def string_array?(value)
      value.is_a?(Array) && value.all? { |item| item.is_a?(String) }
    end

    def non_empty_string_array?(value)
      string_array?(value) && !value.empty? && value.all? { |item| !item.strip.empty? }
    end
  end
end
