# frozen_string_literal: true

require "json"
require "open3"
require "timeout"

module CiHealer
  # Drives `nexum rpc --workspace <dir>` over newline-delimited JSON-RPC 2.0
  # (see src/cli/rpc.ts). One process per heal: send agent.execute, read the reply
  # whose id matches, close stdin so the server calls stopHost() and exits.
  #
  # Note: nexum's `completed` status only means runUserMessage returned without
  # throwing. It says nothing about whether the failure is fixed. The healer
  # verifies the patch itself before anything is pushed.
  class NexumClient
    RPC_ID = 1
    SHUTDOWN_GRACE_SEC = 30

    Outcome = Struct.new(:status, :output, :error, keyword_init: true) do
      def completed?
        status == "completed"
      end
    end

    def initialize(command:, timeout:, log:)
      @command = command
      @timeout = timeout
      @log = log
    end

    def execute(workspace:, goal:)
      argv = @command + ["rpc", "--workspace", workspace]
      Open3.popen3(*argv, chdir: workspace, pgroup: true) do |stdin, stdout, stderr, waiter|
        stderr_reader = Thread.new { stderr.read.to_s }
        begin
          request = { jsonrpc: "2.0", id: RPC_ID, method: "agent.execute", params: { goal: goal } }
          write_request(stdin, request)
          outcome = Timeout.timeout(@timeout) { await(stdout) }
          close_quietly(stdin)
          stop(waiter, SHUTDOWN_GRACE_SEC)
          outcome
        rescue Timeout::Error
          raise TimeoutError, "nexum rpc gave no agent.execute response within #{@timeout}s"
        ensure
          stop(waiter, 0)
          log_stderr(stderr_reader)
        end
      end
    end

    private

    def write_request(stdin, request)
      stdin.write("#{JSON.generate(request)}\n")
      stdin.flush
    rescue Errno::EPIPE
      raise ProtocolError, "nexum rpc exited before receiving the request"
    end

    def await(stdout)
      while (line = stdout.gets)
        message = parse(line)
        next unless message.is_a?(Hash) && message["id"] == RPC_ID

        return to_outcome(message)
      end
      raise ProtocolError, "nexum rpc closed stdout before answering"
    end

    def parse(line)
      JSON.parse(line)
    rescue JSON::ParserError
      @log.debug("non-JSON stdout from nexum ignored", line: line.strip[0, 200])
      nil
    end

    def to_outcome(message)
      if message["error"]
        error = message["error"]
        detail = error.is_a?(Hash) ? error["message"] : error
        return Outcome.new(status: "failed", output: "", error: "rpc error: #{detail}")
      end

      result = message["result"]
      raise ProtocolError, "agent.execute reply has neither result nor error" unless result.is_a?(Hash)

      Outcome.new(status: result["status"].to_s, output: result["output"].to_s, error: result["error"])
    end

    def close_quietly(stdin)
      stdin.close
    rescue IOError, Errno::EPIPE
      nil
    end

    # grace=0 means kill immediately; used in ensure for the crash path.
    def stop(waiter, grace)
      return unless waiter.alive?

      signal_group("TERM", waiter.pid)
      return if grace.positive? && waiter.join(grace)

      signal_group("KILL", waiter.pid)
      waiter.join
    end

    def signal_group(signal, pid)
      Process.kill(signal, -pid)
    rescue Errno::ESRCH, Errno::EPERM
      nil
    end

    def log_stderr(reader)
      text = reader.join(5) ? reader.value : ""
      return if text.strip.empty?

      @log.debug("nexum stderr", tail: text.strip.lines.last(20).join)
    end
  end
end
