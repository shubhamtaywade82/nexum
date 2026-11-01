# frozen_string_literal: true

# Real git (bare origin + clone + worktrees + pushes), real process I/O to a
# scripted `nexum rpc` double, and an in-memory GitHub. Covers the loop-safety
# invariants end to end.
RSpec.describe CiHealer::Healer do
  include GitFixture

  let(:root) { Dir.mktmpdir("healer-spec") }
  let(:fixture) { build_origin_and_clone(root) }
  let(:origin) { fixture[:origin] }
  let(:seed) { fixture[:seed] }
  let(:work) { fixture[:work] }
  let(:state_path) { File.join(root, "state.json") }
  let(:nexum_log) { File.join(root, "nexum.log") }
  let(:github) { FakeGitHub.new }
  let(:log_io) { StringIO.new }
  let(:log) { CiHealer::Log.new(io: log_io) }
  let(:shell) { CiHealer::Shell.new }
  let(:ledger) { CiHealer::Ledger.load(state_path) }

  before do
    fixture
    ENV["FAKE_NEXUM"] = "fix"
    ENV["FAKE_NEXUM_LOG"] = nexum_log
  end

  after do
    ENV.delete("FAKE_NEXUM")
    ENV.delete("FAKE_NEXUM_LOG")
    FileUtils.rm_rf(root)
  end

  def config(overrides = {})
    CiHealer::Config.new({
      "repo" => { "slug" => "acme/app", "dir" => work },
      "state_file" => state_path,
      "kill_switch_file" => File.join(root, "DISABLED"),
      "worktree_base" => File.join(root, "wt"),
      "nexum_command" => [RbConfig.ruby, File.expand_path("../fixtures/fake_nexum.rb", __dir__)],
      "nexum_timeout_sec" => 30,
      "verify_commands" => ["test -f fixed.txt"],
      "verify_timeout_sec" => 30,
      "setup_timeout_sec" => 30
    }.merge(overrides))
  end

  def healer(cfg = config)
    git = CiHealer::Git.new(shell: shell, repo_dir: cfg.repo_dir, author: cfg.git_author, log: log, sleeper: ->(_s) {})
    nexum = CiHealer::NexumClient.new(command: cfg.nexum_command, timeout: cfg.nexum_timeout_sec, log: log)
    logs = CiHealer::LogSource.new(github: github, digester: CiHealer::Digester.new, log: log)
    described_class.new(config: cfg, github: github, git: git, nexum: nexum, logs: logs, shell: shell, log: log)
  end

  def ci_run(id, branch:, sha:, conclusion: "failure", status: "completed", attempt: 1)
    { "databaseId" => id, "headBranch" => branch, "headSha" => sha, "workflowName" => "CI",
      "event" => "push", "attempt" => attempt, "createdAt" => "2026-11-01T00:00:00Z",
      "url" => "https://github.com/acme/app/actions/runs/#{id}", "status" => status, "conclusion" => conclusion }
  end

  def remote_sha(branch)
    git!("rev-parse", "refs/heads/#{branch}", chdir: origin)
  end

  def remote_branch?(branch)
    system("git", "--git-dir", origin, "rev-parse", "--verify", "-q", "refs/heads/#{branch}",
           out: File::NULL, err: File::NULL)
  end

  def nexum_invocations
    File.exist?(nexum_log) ? File.read(nexum_log).scan("<<END>>").size : 0
  end

  def sync_pull(number, head:, state: "OPEN")
    github.pulls[number] = { "state" => state, "headRefOid" => head }
  end

  # Simulates CI failing on the agent branch's current head.
  def fail_agent_head(branch:, head:, run_id:, pr:)
    github.branch_runs[branch] = [ci_run(run_id, branch: branch, sha: head)]
    sync_pull(pr, head: head)
  end

  def main_failure_on(sha, run_id: 111)
    github.failed = [ci_run(run_id, branch: "main", sha: sha)]
  end

  describe "default-branch failure" do
    it "heals into a draft PR against main and leaves the main checkout untouched" do
      m1 = remote_sha("main")
      main_failure_on(m1)
      healer.tick(ledger)

      expect(remote_branch?("fix/ci-main-111")).to be true
      expect(git!("show", "fix/ci-main-111:fixed.txt", chdir: origin)).to include("fixed")
      expect(github.created).to contain_exactly(hash_including(base: "main", head: "fix/ci-main-111"))
      expect(ledger.lineage("fix/ci-main-111")).to include("state" => "PR_OPEN", "pr_number" => 1, "attempts" => 1)
      expect(ledger.handled_outcome("main", m1)).to eq("PR_OPEN")

      expect(git!("status", "--porcelain", chdir: work)).to eq("")
      expect(git!("branch", "--list", "fix/ci-main-111", chdir: work)).to eq("")
      expect(Dir.children(File.join(root, "wt"))).to be_empty
    end

    it "never re-invokes nexum for a failing commit it has already handled" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)
      sync_pull(1, head: remote_sha("fix/ci-main-111"))
      healer.tick(ledger)

      expect(nexum_invocations).to eq(1)
      expect(github.created.size).to eq(1)
    end

    it "gives the agent the failure digest inside a nonce-delimited, untrusted block" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)

      goal = File.read(nexum_log)
      expect(goal).to match(/<<<CI_LOG_BEGIN (\h+)\n.*CI_LOG_END \1>>>/m)
      expect(goal).to include("Do not commit, push, or create branches")
    end
  end

  describe "verification and policy gates" do
    it "pushes nothing when the verify command fails after the agent's edit" do
      m1 = remote_sha("main")
      ENV["FAKE_NEXUM"] = "noop"
      main_failure_on(m1)
      healer.tick(ledger)

      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(github.created).to be_empty
      expect(ledger.handled_outcome("main", m1)).to eq("NO_PATCH")
      expect(git!("branch", "--list", "fix/ci-main-111", chdir: work)).to eq("")
    end

    it "pushes nothing when the agent changed files but verification still fails" do
      m1 = remote_sha("main")
      ENV["FAKE_NEXUM"] = "edit_unrelated"
      main_failure_on(m1)
      healer.tick(ledger)

      expect(File.read(nexum_log)).to include("<<END>>") # agent did run
      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(github.created).to be_empty
      expect(ledger.handled_outcome("main", m1)).to eq("NO_PATCH")
      expect(log_io.string).to include("verification failed")
    end

    it "refuses a patch that touches CI workflow files, even when verification passes" do
      m1 = remote_sha("main")
      ENV["FAKE_NEXUM"] = "fix_forbidden"
      main_failure_on(m1)
      healer.tick(ledger)

      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(github.created).to be_empty
      expect(log_io.string).to include("forbidden paths")
    end

    it "pushes nothing when nexum reports failure" do
      ENV["FAKE_NEXUM"] = "fail"
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)

      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(log_io.string).to include("model unavailable")
    end

    it "marks the head ERRORED and pushes nothing when environment setup fails" do
      m1 = remote_sha("main")
      main_failure_on(m1)
      cfg = config("setup_commands" => ["exit 1"])
      healer(cfg).tick(ledger)

      expect(nexum_invocations).to eq(0)
      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(ledger.handled_outcome("main", m1)).to eq("ERRORED")
      expect(log_io.string).to include("needs a human reset")
    end

    it "treats a nexum crash as a no-patch outcome rather than a daemon crash" do
      ENV["FAKE_NEXUM"] = "crash"
      m1 = remote_sha("main")
      main_failure_on(m1)
      expect { healer.tick(ledger) }.not_to raise_error

      expect(ledger.handled_outcome("main", m1)).to eq("NO_PATCH")
    end
  end

  describe "in-place iteration on agent PRs" do
    it "spends at most max_heal_attempts_per_lineage attempts, then stops and reports EXHAUSTED" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)

      heads = [remote_sha("fix/ci-main-111")]
      (2..3).each do |attempt|
        fail_agent_head(branch: "fix/ci-main-111", head: heads.last, run_id: 200 + attempt, pr: 1)
        healer.tick(ledger)
        heads << remote_sha("fix/ci-main-111")

        expect(heads.last).not_to eq(heads[-2])
        expect(ledger.lineage("fix/ci-main-111")["attempts"]).to eq(attempt)
      end

      fail_agent_head(branch: "fix/ci-main-111", head: heads.last, run_id: 299, pr: 1)
      healer.tick(ledger)

      expect(ledger.lineage("fix/ci-main-111")["state"]).to eq("EXHAUSTED")
      expect(remote_sha("fix/ci-main-111")).to eq(heads.last)
      expect(nexum_invocations).to eq(3)
    end

    it "does not spend a second attempt on a head after a crash mid-heal" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)
      h1 = remote_sha("fix/ci-main-111")

      fail_agent_head(branch: "fix/ci-main-111", head: h1, run_id: 201, pr: 1)
      ledger.update!("fix/ci-main-111", attempts: 2, last_attempted_sha: h1)
      ledger.transition!("fix/ci-main-111", "HEALING")

      healer.tick(ledger)
      expect(ledger.lineage("fix/ci-main-111")["state"]).to eq("PR_OPEN")
      expect(nexum_invocations).to eq(1)
    end

    it "moves to GREEN when the PR head is green, then CLOSED when merged" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)
      h1 = remote_sha("fix/ci-main-111")

      github.branch_runs["fix/ci-main-111"] = [ci_run(301, branch: "fix/ci-main-111", sha: h1, conclusion: "success")]
      sync_pull(1, head: h1)
      healer.tick(ledger)
      expect(ledger.lineage("fix/ci-main-111")["state"]).to eq("GREEN")

      sync_pull(1, head: h1, state: "MERGED")
      healer.tick(ledger)
      expect(ledger.lineage("fix/ci-main-111")["state"]).to eq("CLOSED")
    end

    it "waits while checks are still running on the current head" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)
      h1 = remote_sha("fix/ci-main-111")

      github.branch_runs["fix/ci-main-111"] = [ci_run(401, branch: "fix/ci-main-111", sha: h1, status: "in_progress", conclusion: "")]
      sync_pull(1, head: h1)
      healer.tick(ledger)

      expect(ledger.lineage("fix/ci-main-111")["state"]).to eq("PR_OPEN")
      expect(nexum_invocations).to eq(1)
    end
  end

  describe "candidate filtering" do
    it "skips a failure whose SHA is no longer the branch head" do
      github.failed = [ci_run(150, branch: "main", sha: "0" * 40)]
      healer.tick(ledger)

      expect(nexum_invocations).to eq(0)
      expect(github.created).to be_empty
    end

    it "allows only one open agent lineage per base branch" do
      main_failure_on(remote_sha("main"))
      healer.tick(ledger)

      publish(seed, branch: "main", file: "app.rb", content: "v2\n")
      m2 = remote_sha("main")
      github.failed = [ci_run(112, branch: "main", sha: m2)]
      healer.tick(ledger)

      expect(nexum_invocations).to eq(1)
      expect(github.created.size).to eq(1)
    end

    it "heals a failing feature branch that has an open PR, targeting that branch" do
      f1 = publish(seed, branch: "feature/x", file: "lib/x.rb", content: "x\n")
      github.open_prs = [{ "number" => 7, "headRefName" => "feature/x", "baseRefName" => "main",
                           "headRefOid" => f1, "isCrossRepository" => false, "isDraft" => false }]
      github.failed = [ci_run(301, branch: "feature/x", sha: f1)]
      healer.tick(ledger)

      expect(remote_branch?("fix/ci-feature-x-301")).to be true
      expect(github.created).to contain_exactly(hash_including(base: "feature/x", head: "fix/ci-feature-x-301"))
    end

    it "ignores a failing branch that has no open PR" do
      f1 = publish(seed, branch: "orphan", file: "o.rb", content: "o\n")
      github.failed = [ci_run(302, branch: "orphan", sha: f1)]
      healer.tick(ledger)

      expect(nexum_invocations).to eq(0)
    end
  end

  describe "dry run" do
    it "reports the plan without writing ledger, branches, or PRs" do
      m1 = remote_sha("main")
      main_failure_on(m1)
      lines = healer.plan(ledger)

      expect(lines.join("\n")).to include("would heal run=111 branch=main base=main head=#{m1[0, 7]}")
      expect(File.exist?(state_path)).to be false
      expect(remote_branch?("fix/ci-main-111")).to be false
      expect(nexum_invocations).to eq(0)
    end
  end
end
