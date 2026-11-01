# frozen_string_literal: true

RSpec.describe CiHealer::Shell do
  subject(:shell) { described_class.new }

  it "returns stdout and status for a successful command" do
    result = shell.run(["echo", "hello"])
    expect(result).to be_ok
    expect(result.stdout).to eq("hello\n")
  end

  it "raises CommandError with stderr on failure" do
    expect { shell.run(["sh", "-c", "echo bad >&2; exit 4"]) }
      .to raise_error(CiHealer::CommandError, /exited 4: bad/)
  end

  it "returns a failed result instead of raising when allow_failure is set" do
    result = shell.run(["sh", "-c", "exit 2"], allow_failure: true)
    expect(result.status).to eq(2)
  end

  it "kills a command that exceeds its timeout and raises TimeoutError promptly" do
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    expect { shell.run(["sleep", "30"], timeout: 1) }.to raise_error(CiHealer::TimeoutError)
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 10
  end
end

RSpec.describe CiHealer::NexumClient do
  let(:dir) { Dir.mktmpdir("nexum-client-spec") }
  let(:log) { CiHealer::Log.new(io: StringIO.new) }
  let(:fixture) { File.expand_path("../fixtures/fake_nexum.rb", __dir__) }

  after do
    FileUtils.rm_rf(dir)
    ENV.delete("FAKE_NEXUM")
  end

  def client(command: [RbConfig.ruby, fixture], timeout: 20)
    described_class.new(command: command, timeout: timeout, log: log)
  end

  it "returns completed when agent.execute replies completed, ignoring non-JSON stdout noise" do
    ENV["FAKE_NEXUM"] = "fix"
    outcome = client.execute(workspace: dir, goal: "fix it")
    expect(outcome).to be_completed
    expect(outcome.output).to eq("patched")
    expect(File.read(File.join(dir, "fixed.txt"))).to eq("fixed\n")
  end

  it "reports a failed status with the agent's error" do
    ENV["FAKE_NEXUM"] = "fail"
    outcome = client.execute(workspace: dir, goal: "fix it")
    expect(outcome.status).to eq("failed")
    expect(outcome.error).to eq("model unavailable")
  end

  it "raises ProtocolError when the server exits without answering" do
    ENV["FAKE_NEXUM"] = "crash"
    expect { client.execute(workspace: dir, goal: "fix it") }.to raise_error(CiHealer::ProtocolError)
  end

  it "raises TimeoutError and kills a server that never answers" do
    sleeper = [RbConfig.ruby, "-e", "sleep 60"]
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    expect { client(command: sleeper, timeout: 1).execute(workspace: dir, goal: "x") }
      .to raise_error(CiHealer::TimeoutError)
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 15
  end

  it "maps a JSON-RPC error object to a failed outcome" do
    script = File.join(dir, "rpc_error.rb")
    File.write(script, <<~RUBY)
      require "json"
      $stdin.gets
      puts JSON.generate({ jsonrpc: "2.0", id: 1, error: { code: -32_602, message: "bad params" } })
    RUBY
    outcome = client(command: [RbConfig.ruby, script]).execute(workspace: dir, goal: "x")
    expect(outcome.status).to eq("failed")
    expect(outcome.error).to include("bad params")
  end
end

RSpec.describe CiHealer::Prompt do
  it "wraps the CI log in a nonce-delimited block and forbids CI-config edits" do
    prompt = described_class.build(repo: "acme/app", source_branch: "main", workflow: "CI", run_id: 9,
                                   attempt: 2, max_attempts: 3, digest: "ERROR boom", nonce: "abc123")

    expect(prompt).to include("<<<CI_LOG_BEGIN abc123")
    expect(prompt).to include("CI_LOG_END abc123>>>")
    expect(prompt).to include("ERROR boom")
    expect(prompt).to include("attempt 2 of 3")
    expect(prompt).to match(/Do not edit CI configuration/)
  end
end
