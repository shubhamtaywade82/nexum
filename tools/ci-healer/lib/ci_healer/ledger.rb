# frozen_string_literal: true

require "json"
require "fileutils"
require "time"

module CiHealer
  # Authoritative record of every heal lineage and every failing head SHA the
  # daemon has acted on. Persisted atomically (tmp file + rename) after every
  # mutation, so a crash never leaves a half-written ledger.
  #
  # Lineage state machine, keyed by heal branch:
  #
  #   HEALING ──► PR_OPEN ◄──► GREEN
  #      ▲          │   │         │
  #      │          ▼   ▼         ▼
  #      └───── (failing, attempts left) ──┘
  #                 │
  #                 ▼
  #             EXHAUSTED ──► GREEN
  #
  #   PR_OPEN | GREEN | EXHAUSTED ──► CLOSED   (PR merged or closed; terminal)
  #
  # `handled_heads` records, per "base@sha", that a failing head has been acted on
  # (or deliberately skipped). The same failing commit is never retried.
  class Ledger
    FORMAT_VERSION = 1
    HANDLED_CAP = 1000

    LINEAGE_TRANSITIONS = {
      "HEALING" => %w[PR_OPEN CLOSED],
      "PR_OPEN" => %w[HEALING GREEN EXHAUSTED CLOSED],
      "GREEN" => %w[HEALING PR_OPEN EXHAUSTED CLOSED],
      "EXHAUSTED" => %w[GREEN CLOSED],
      "CLOSED" => []
    }.freeze

    ACTIVE_STATES = %w[HEALING PR_OPEN GREEN EXHAUSTED].freeze
    HEAD_OUTCOMES = %w[HEALING PR_OPEN NO_PATCH ERRORED].freeze

    attr_reader :path

    def self.load(path)
      expanded = File.expand_path(path)
      data = File.exist?(expanded) ? parse(expanded) : empty_data
      new(expanded, data)
    end

    # Holds an exclusive, non-blocking flock for the duration of the block. A second
    # concurrent tick raises LockHeld instead of racing on the same PRs.
    def self.with_lock(path)
      expanded = File.expand_path(path)
      FileUtils.mkdir_p(File.dirname(expanded))
      File.open("#{expanded}.lock", File::RDWR | File::CREAT, 0o600) do |lock|
        raise LockHeld, "another ci-healer tick holds #{expanded}.lock" unless lock.flock(File::LOCK_EX | File::LOCK_NB)

        yield load(expanded)
      end
    end

    def self.parse(path)
      data = JSON.parse(File.read(path))
      validate_shape!(data, path)
      data
    rescue JSON::ParserError => e
      raise StateError, "ledger #{path} is corrupt (#{e.message}). Refusing to run: an empty ledger would re-open handled failures. Review open PRs, then move the file aside."
    end

    def self.empty_data
      { "version" => FORMAT_VERSION, "lineages" => {}, "handled_heads" => {} }
    end

    def self.validate_shape!(data, path)
      valid = data.is_a?(Hash) && data["version"] == FORMAT_VERSION &&
              data["lineages"].is_a?(Hash) && data["handled_heads"].is_a?(Hash)
      raise StateError, "ledger #{path} has an unexpected shape or version" unless valid
    end

    def initialize(path, data)
      @path = path
      @data = data
    end

    def lineage(heal_branch)
      @data["lineages"][heal_branch]
    end

    def lineages
      @data["lineages"].values
    end

    def active_lineages
      lineages.select { |entry| ACTIVE_STATES.include?(entry["state"]) }
    end

    def active_for_base(base)
      active_lineages.select { |entry| entry["base_branch"] == base }
    end

    def handled_head?(base, sha)
      @data["handled_heads"].key?(head_key(base, sha))
    end

    def handled_outcome(base, sha)
      @data["handled_heads"].dig(head_key(base, sha), "outcome")
    end

    def add_lineage!(heal_branch:, base_branch:, origin_run_id:, origin_sha:, pr_number:, attempts:)
      raise StateError, "lineage #{heal_branch} already exists" if lineage(heal_branch)

      @data["lineages"][heal_branch] = {
        "heal_branch" => heal_branch,
        "base_branch" => base_branch,
        "origin_run_id" => origin_run_id,
        "origin_sha" => origin_sha,
        "pr_number" => pr_number,
        "state" => "PR_OPEN",
        "attempts" => attempts,
        "last_attempted_sha" => origin_sha,
        "last_pushed_sha" => nil,
        "created_at" => timestamp,
        "updated_at" => timestamp
      }
      persist!
    end

    def transition!(heal_branch, to, **attrs)
      entry = fetch!(heal_branch)
      from = entry["state"]
      return update!(heal_branch, **attrs) if from == to

      allowed = LINEAGE_TRANSITIONS.fetch(from) { raise StateError, "unknown lineage state #{from}" }
      raise StateError, "illegal transition #{from} -> #{to} for #{heal_branch}" unless allowed.include?(to)

      entry["state"] = to
      apply(entry, attrs)
      persist!
    end

    def update!(heal_branch, **attrs)
      apply(fetch!(heal_branch), attrs)
      persist!
    end

    # Called at the start of a tick. A HEALING lineage can only exist if the
    # previous process died mid-heal; the attempt was already counted, so it resumes
    # as PR_OPEN and the budget stays bounded.
    def recover_interrupted!
      lineages.select { |entry| entry["state"] == "HEALING" }.map do |entry|
        transition!(entry["heal_branch"], "PR_OPEN", recovered_at: timestamp)
        entry["heal_branch"]
      end
    end

    def mark_head!(base, sha, outcome)
      raise StateError, "unknown head outcome #{outcome}" unless HEAD_OUTCOMES.include?(outcome)

      key = head_key(base, sha)
      heads = @data["handled_heads"]
      heads.delete(key)
      heads[key] = { "outcome" => outcome, "at" => timestamp }
      heads.shift while heads.size > HANDLED_CAP
      persist!
    end

    def persist!
      FileUtils.mkdir_p(File.dirname(@path))
      tmp = "#{@path}.tmp-#{Process.pid}"
      File.open(tmp, "w", 0o600) do |file|
        file.write(JSON.pretty_generate(@data))
        file.flush
        file.fsync
      end
      File.rename(tmp, @path)
    end

    private

    def fetch!(heal_branch)
      lineage(heal_branch) || raise(StateError, "unknown lineage #{heal_branch}")
    end

    def apply(entry, attrs)
      attrs.each { |key, value| entry[key.to_s] = value }
      entry["updated_at"] = timestamp
    end

    def head_key(base, sha)
      "#{base}@#{sha}"
    end

    def timestamp
      Time.now.utc.iso8601
    end
  end
end
