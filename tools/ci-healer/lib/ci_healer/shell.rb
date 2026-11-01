# frozen_string_literal: true

require "open3"

module CiHealer
  # Runs external commands from argv arrays. Shell strings are used only for the
  # operator-configured setup and verify commands, which are passed to `sh -c`
  # explicitly by the caller.
  class Shell
    Result = Struct.new(:stdout, :stderr, :status, keyword_init: true) do
      def ok?
        status.zero?
      end
    end

    KILL_GRACE_SEC = 5

    # clean_env: true replaces the inherited environment entirely with `env`, so
    # nothing from the daemon's own environment leaks into the child process.
    def run(argv, chdir: nil, stdin: nil, timeout: 120, env: {}, allow_failure: false, clean_env: false)
      stdout = stderr = status = nil
      options = { chdir: chdir || Dir.pwd, pgroup: true }
      options[:unsetenv_others] = true if clean_env

      Open3.popen3(env, *argv, **options) do |inp, out, err, waiter|
        out_reader = Thread.new { out.read.to_s }
        err_reader = Thread.new { err.read.to_s }

        begin
          inp.write(stdin) if stdin
        rescue Errno::EPIPE
          nil
        ensure
          inp.close
        end

        unless waiter.join(timeout)
          terminate(waiter)
          raise TimeoutError, "timed out after #{timeout}s: #{argv.first(3).join(" ")}"
        end

        stdout = out_reader.value
        stderr = err_reader.value
        final = waiter.value
        status = final.exitstatus || (128 + final.termsig.to_i)
      end

      result = Result.new(stdout: stdout, stderr: stderr, status: status)
      raise CommandError.new(argv, status, stderr) unless result.ok? || allow_failure

      result
    end

    private

    def terminate(waiter)
      signal_group("TERM", waiter.pid)
      return if waiter.join(KILL_GRACE_SEC)

      signal_group("KILL", waiter.pid)
      waiter.join
    end

    def signal_group(signal, pid)
      Process.kill(signal, -pid)
    rescue Errno::ESRCH, Errno::EPERM
      nil
    end
  end
end
