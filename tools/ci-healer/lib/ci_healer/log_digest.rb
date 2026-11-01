# frozen_string_literal: true

module CiHealer
  # Deterministic first pass over `gh run view --log-failed` output. It strips ANSI
  # codes and the job/step/timestamp prefix, keeps failure-bearing lines plus
  # context, and caps the size. It runs before any LLM, so the model never sees
  # install noise and the digest is reproducible.
  class Digester
    ANSI = /\e\[[0-9;?]*[ -\/]*[@-~]/
    GH_PREFIX = /\A[^\t]*\t[^\t]*\t(?:\d{4}-\d{2}-\d{2}T\S+\s?)?/
    SIGNAL = Regexp.union(
      /\b(?:error|errors|fail|failed|failing|failure|failures|exception|traceback|panic|expected|undefined|cannot|assertion|not found|no such file)\b/i,
      /\b(?:TypeError|NameError|NoMethodError|LoadError|ArgumentError|RuntimeError|SyntaxError|ReferenceError)\b/,
      %r{[\w/.-]+\.(?:rb|rake|ts|tsx|js|jsx|mjs|py|go|rs|java|kt|ex|exs):\d+},
      /^\s*at\s+\S+/,
      /##\[error\]/
    )

    attr_reader :byte_cap

    def initialize(line_cap: 400, byte_cap: 16_000, context: 2, tail_lines: 120)
      @line_cap = line_cap
      @byte_cap = byte_cap
      @context = context
      @tail_lines = tail_lines
    end

    def digest(raw)
      lines = normalize(raw)
      return "" if lines.empty?

      indexes = signal_indexes(lines)
      body = indexes.empty? ? lines.last(@tail_lines) : collapse(lines, indexes)
      cap_bytes(cap_lines(body).join("\n"))
    end

    private

    def normalize(raw)
      text = raw.to_s.dup.force_encoding(Encoding::UTF_8).scrub("?")
      text.each_line.filter_map do |line|
        cleaned = line.delete("\r").gsub(ANSI, "").sub(GH_PREFIX, "").rstrip
        cleaned unless cleaned.strip.empty?
      end
    end

    def signal_indexes(lines)
      hits = lines.each_index.select { |i| SIGNAL.match?(lines[i]) }
      return [] if hits.empty?

      last = lines.size - 1
      hits.flat_map { |i| ([i - @context, 0].max..[i + @context, last].min).to_a }.uniq.sort
    end

    def collapse(lines, indexes)
      out = []
      previous = nil
      indexes.each do |i|
        out << "..." if previous && i > previous + 1
        out << lines[i]
        previous = i
      end
      out
    end

    def cap_lines(body)
      return body if body.size <= @line_cap

      half = @line_cap / 2
      body.first(half) + ["... #{body.size - @line_cap} lines elided ..."] + body.last(half)
    end

    def cap_bytes(text)
      return text if text.bytesize <= @byte_cap

      head_len = @byte_cap / 2
      tail_len = @byte_cap - head_len
      "#{text.byteslice(0, head_len).scrub}\n... [digest truncated] ...\n#{text.byteslice(-tail_len, tail_len).scrub}"
    end
  end

  # Fetches failed-job logs for a run and produces the digest the agent receives.
  # The optional condenser is a local model pass; if it is unavailable the
  # deterministic digest is used, so an Ollama outage never blocks healing.
  class LogSource
    def initialize(github:, digester:, log:, condenser: nil, byte_cap: 2_000_000)
      @github = github
      @digester = digester
      @log = log
      @condenser = condenser
      @byte_cap = byte_cap
    end

    def digest_for(run_id)
      raw = @github.failed_log(run_id)
      raw = raw.byteslice(-@byte_cap, @byte_cap).scrub("?") if raw.bytesize > @byte_cap
      digest = @digester.digest(raw)
      return digest unless @condenser

      @condenser.condense(digest).byteslice(0, @digester.byte_cap).scrub("?")
    rescue CondenserError => e
      @log.warn("condenser unavailable; using deterministic digest", error: e.message)
      digest
    end
  end
end
