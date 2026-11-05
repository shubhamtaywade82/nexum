# frozen_string_literal: true

RSpec.describe CiHealer::GitHub do
  let(:shell) { ScriptedShell.new }
  let(:gh) { described_class.new(shell: shell, slug: "acme/app", cwd: "/repo") }

  it "reads the default branch from gh repo view" do
    shell.on(%w[gh repo view], stdout: '{"defaultBranchRef":{"name":"trunk"}}')
    expect(gh.default_branch).to eq("trunk")
  end

  it "requests failed runs with the fields the healer depends on" do
    shell.on(%w[gh run list], stdout: "[]")
    gh.failed_runs(15)

    argv = shell.calls.last[:argv]
    expect(argv).to include("--status", "failure", "--limit", "15")
    expect(argv.last).to include("headSha", "databaseId", "conclusion", "attempt")
  end

  it "parses the PR URL printed by gh pr create and sends the body on stdin" do
    shell.on(%w[gh pr create], stdout: "https://github.com/acme/app/pull/42\n")
    number = gh.create_draft_pull_request(base: "main", head: "fix/ci-main-1", title: "t", body: "the body")

    expect(number).to eq(42)
    call = shell.calls.last
    expect(call[:argv]).to include("--draft", "--base", "main", "--head", "fix/ci-main-1")
    expect(call[:argv]).to include("--body-file", "-")
    expect(call[:opts][:stdin]).to eq("the body")
  end

  it "raises ProtocolError when gh pr create prints no URL" do
    shell.on(%w[gh pr create], stdout: "something unexpected")
    expect { gh.create_draft_pull_request(base: "main", head: "h", title: "t", body: "b") }
      .to raise_error(CiHealer::ProtocolError, /no PR URL/)
  end

  it "raises ProtocolError on non-JSON output instead of guessing" do
    shell.on(%w[gh run list], stdout: "rate limited")
    expect { gh.failed_runs(5) }.to raise_error(CiHealer::ProtocolError, /non-JSON/)
  end
end

RSpec.describe CiHealer::Git do
  let(:shell) { ScriptedShell.new }
  let(:log_io) { StringIO.new }
  let(:sleeps) { [] }
  let(:git) do
    described_class.new(shell: shell, repo_dir: "/repo", author: { "name" => "bot", "email" => "bot@x" },
                        log: CiHealer::Log.new(io: log_io), sleeper: ->(s) { sleeps << s })
  end

  it "retries transient fetch failures with the documented backoff, then succeeds" do
    shell.on(%w[git fetch], { status: 128, stderr: "Could not resolve host: github.com" },
             { status: 128, stderr: "Could not resolve host: github.com" }, { stdout: "" })
    git.fetch

    expect(sleeps).to eq([2, 4])
    expect(shell.calls.size).to eq(3)
  end

  it "does not retry rejected pushes, which retrying cannot fix" do
    shell.on(%w[git push], { status: 1, stderr: "! [rejected] fix (non-fast-forward)" })
    expect { git.push("/wt", "HEAD:refs/heads/fix") }.to raise_error(CiHealer::CommandError)
    expect(sleeps).to be_empty
    expect(shell.calls.size).to eq(1)
  end

  it "gives up after the retry budget is exhausted" do
    shell.on(%w[git fetch], { status: 128, stderr: "Connection timed out" })
    expect { git.fetch }.to raise_error(CiHealer::CommandError)
    expect(sleeps).to eq([2, 4, 8, 16])
  end

  it "returns nil for a branch that is not on origin" do
    shell.on(%w[git rev-parse], status: 1)
    expect(git.remote_head("ghost")).to be_nil
  end

  it "parses NUL-separated changed paths, including names with spaces" do
    shell.on(%w[git add], stdout: "")
    shell.on(%w[git diff], stdout: "lib/a b.rb\0spec/x_spec.rb\0")
    expect(git.stage_all_and_list("/wt")).to eq(["lib/a b.rb", "spec/x_spec.rb"])
  end

  it "passes the configured author identity through the environment for commits" do
    shell.on(%w[git commit], stdout: "")
    git.commit("/wt", "fix(ci): msg")
    expect(shell.calls.last[:opts][:env]).to include(
      "GIT_AUTHOR_NAME" => "bot", "GIT_AUTHOR_EMAIL" => "bot@x",
      "GIT_COMMITTER_NAME" => "bot", "GIT_COMMITTER_EMAIL" => "bot@x"
    )
  end
end
