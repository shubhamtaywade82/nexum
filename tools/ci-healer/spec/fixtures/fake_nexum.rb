#!/usr/bin/env ruby
# frozen_string_literal: true

# Test double for `nexum rpc --workspace <dir>`. It speaks the same NDJSON JSON-RPC
# wire format, prints one non-protocol line to prove the client ignores noise, and
# applies the edit selected by FAKE_NEXUM. Each goal is appended to FAKE_NEXUM_LOG,
# followed by a separator, so tests can count invocations and inspect prompts.
require "json"
require "fileutils"

puts "fake-nexum: booting (non-JSON-RPC line)"
$stdout.flush

mode = ENV.fetch("FAKE_NEXUM", "fix")
log_path = ENV["FAKE_NEXUM_LOG"]

def reply(id, status, output: "", error: nil)
  puts JSON.generate({ jsonrpc: "2.0", id: id, result: { status: status, output: output, error: error } })
  $stdout.flush
end

while (line = $stdin.gets)
  request = JSON.parse(line)
  next unless request["method"] == "agent.execute"

  goal = request.dig("params", "goal").to_s
  File.open(log_path, "a") { |file| file.write("#{goal}\n<<END>>\n") } if log_path

  case mode
  when "fix"
    File.open("fixed.txt", "a") { |file| file.puts("fixed") }
    reply(request["id"], "completed", output: "patched")
  when "fix_forbidden"
    File.open("fixed.txt", "a") { |file| file.puts("fixed") }
    FileUtils.mkdir_p(".github/workflows")
    File.write(".github/workflows/ci.yml", "on: push\n")
    reply(request["id"], "completed")
  when "noop"
    reply(request["id"], "completed", output: "looked, changed nothing")
  when "edit_unrelated"
    # Changes files but does not make the verify command pass.
    File.write("notes.txt", "investigated\n")
    reply(request["id"], "completed", output: "edited the wrong thing")
  when "env"
    # Reports which credentials the child process can see, so tests can prove the policy.
    reply(request["id"], "completed",
          output: "GH=#{ENV.fetch("GH_TOKEN", "absent")} OLLAMA=#{ENV.fetch("OLLAMA_API_KEY", "absent")}")
  when "fail"
    reply(request["id"], "failed", error: "model unavailable")
  when "crash"
    exit 3
  end
end
