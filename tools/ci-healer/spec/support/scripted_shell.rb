# frozen_string_literal: true

# Replaces CiHealer::Shell in unit tests. Each rule matches an argv prefix and
# returns scripted results in order (the last one repeats). Unmatched commands
# fail the test loudly instead of silently succeeding.
class ScriptedShell
  attr_reader :calls

  def initialize
    @calls = []
    @rules = []
  end

  def on(prefix, *results)
    @rules << [prefix, results]
    self
  end

  def run(argv, **opts)
    @calls << { argv: argv, opts: opts }
    _, results = @rules.find { |prefix, _| argv.first(prefix.size) == prefix }
    raise "unexpected command: #{argv.join(" ")}" unless results

    spec = results.size > 1 ? results.shift : results.first
    status = spec.fetch(:status, 0)
    stderr = spec.fetch(:stderr, "")
    result = CiHealer::Shell::Result.new(stdout: spec.fetch(:stdout, ""), stderr: stderr, status: status)
    raise CiHealer::CommandError.new(argv, status, stderr) unless result.ok? || opts[:allow_failure]

    result
  end
end
