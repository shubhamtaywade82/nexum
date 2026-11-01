# frozen_string_literal: true

module CiHealer
  # Single-line key=value logger. Output is cron-friendly and grep-able.
  # Level comes from the constructor or CI_HEALER_LOG_LEVEL (debug|info|warn|error).
  class Log
    LEVELS = %i[debug info warn error].freeze

    def initialize(io: $stderr, clock: -> { Time.now.utc }, level: nil)
      @io = io
      @clock = clock
      @threshold = LEVELS.index((level || ENV.fetch("CI_HEALER_LOG_LEVEL", "info")).to_sym) ||
                   raise(ArgumentError, "unknown log level: #{level}")
    end

    LEVELS.each do |level|
      define_method(level) do |message, **fields|
        write(level, message, fields) if LEVELS.index(level) >= @threshold
      end
    end

    private

    def write(level, message, fields)
      stamp = @clock.call.strftime("%Y-%m-%dT%H:%M:%SZ")
      pairs = fields.map { |key, value| " #{key}=#{value.inspect}" }.join
      @io.puts("#{stamp} #{level.to_s.upcase.ljust(5)} #{message}#{pairs}")
    end
  end
end
