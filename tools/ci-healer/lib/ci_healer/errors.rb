# frozen_string_literal: true

module CiHealer
  class Error < StandardError; end

  # Operator-facing configuration problem. The daemon refuses to start.
  class ConfigError < Error; end

  # Ledger is unreadable or inconsistent. Fail closed: continuing with an empty
  # ledger would re-open PRs for failures that were already handled.
  class StateError < Error; end

  # Another tick holds the ledger lock.
  class LockHeld < Error; end

  # An external command exited non-zero.
  class CommandError < Error
    attr_reader :argv, :status, :stderr

    def initialize(argv, status, stderr)
      @argv = argv
      @status = status
      @stderr = stderr.to_s
      tail = @stderr.strip
      tail = "...#{tail[-500..]}" if tail.length > 500
      super("`#{argv.first(3).join(" ")}` exited #{status}: #{tail}")
    end
  end

  class TimeoutError < Error; end

  # Malformed output or a JSON-RPC contract violation.
  class ProtocolError < Error; end

  class CondenserError < Error; end
end
