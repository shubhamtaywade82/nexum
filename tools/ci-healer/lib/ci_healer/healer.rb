# frozen_string_literal: true

require "fileutils"

module CiHealer
  # One scheduler tick:
  #   1. reconcile existing agent lineages against GitHub: closed/merged, green, or
  #      failing on the current head (in-place iteration within the attempt budget)
  #   2. evaluate newly failing runs on the default branch and open same-repo PRs
  #   3. heal at most max_heals_per_tick new failures
  #
  # Every side effect goes through injected collaborators. The ledger is the only
  # source of truth for whether a head has already been acted on.
  class Healer
    PASSING = %w[success skipped neutral].freeze
    FAILING = %w[failure timed_out].freeze

    Verdict = Struct.new(:run, :candidate, :reason, keyword_init: true)
    Candidate = Struct.new(:run, :kind, :base, :head, keyword_init: true)
    Checks = Struct.new(:verdict, :run, keyword_init: true)

    attr_reader :config, :github, :git, :nexum, :logs, :shell, :log

    def initialize(config:, github:, git:, nexum:, logs:, shell:, log:)
      @config = config
      @github = github
      @git = git
      @nexum = nexum
      @logs = logs
      @shell = shell
      @log = log
    end

    def tick(ledger)
      FileUtils.mkdir_p(config.worktree_base)
      git.prune_worktrees
      git.fetch
      reconcile(ledger)

      budget = config.max_heals_per_tick
      evaluate(ledger, github.default_branch).each do |verdict|
        if verdict.candidate.nil?
          log.debug("skipped run", run: verdict.run["databaseId"], branch: verdict.run["headBranch"], reason: verdict.reason)
          next
        end
        break if budget.zero?

        candidate = verdict.candidate
        if ledger.active_for_base(candidate.base).size >= config.max_open_prs_per_base
          log.info("deferred: base already has an open agent PR", base: candidate.base, run: candidate.run["databaseId"])
          next
        end

        heal_new(ledger, candidate)
        budget -= 1
      end
    end

    # Read-only report for --dry-run. Fetches refs but writes nothing to the ledger,
    # git worktrees, or GitHub.
    def plan(ledger)
      git.fetch
      lines = ledger.active_lineages.map do |entry|
        "lineage #{entry["heal_branch"]} state=#{entry["state"]} attempts=#{entry["attempts"]} pr=##{entry["pr_number"]}"
      end

      evaluate(ledger, github.default_branch).each do |verdict|
        lines << plan_line(verdict)
      end
      lines
    end

    private

    def plan_line(verdict)
      if verdict.candidate
        cand = verdict.candidate
        "would heal run=#{verdict.run["databaseId"]} branch=#{verdict.run["headBranch"]} base=#{cand.base} head=#{short(cand.head)}"
      else
        "skip run=#{verdict.run["databaseId"]} branch=#{verdict.run["headBranch"]}: #{verdict.reason}"
      end
    end

    # ── reconciliation of existing lineages ──────────────────────────────────

    def reconcile(ledger)
      ledger.recover_interrupted!.each { |name| log.warn("recovered interrupted heal", heal_branch: name) }

      ledger.active_lineages.each do |entry|
        reconcile_lineage(ledger, entry)
      rescue CommandError, TimeoutError, ProtocolError => e
        log.warn("lineage check failed; retrying next tick", heal_branch: entry["heal_branch"], error: e.message)
      end
    end

    def reconcile_lineage(ledger, entry)
      name = entry["heal_branch"]
      pr = github.pull_request(entry["pr_number"])

      unless pr["state"] == "OPEN"
        ledger.transition!(name, "CLOSED", pr_state: pr["state"])
        log.info("lineage closed", heal_branch: name, pr_state: pr["state"])
        return
      end

      head = pr["headRefOid"]
      checks = checks_for(name, head)
      case checks.verdict
      when :green
        previous = entry["state"]
        ledger.transition!(name, "GREEN")
        log.info("checks green on agent PR", heal_branch: name, pr: entry["pr_number"]) unless previous == "GREEN"
      when :failing
        handle_failure(ledger, entry, head, checks.run)
      end
    end

    # Verdict for the PR head only. Pending or indeterminate results mean wait.
    def checks_for(branch, head)
      runs = github.runs_for_branch(branch).select { |run| run["headSha"] == head }
      latest = latest_per_workflow(runs)
      return Checks.new(verdict: :pending) if latest.empty? || latest.any? { |run| run["status"] != "completed" }

      failing = latest.find { |run| FAILING.include?(run["conclusion"]) }
      return Checks.new(verdict: :failing, run: failing) if failing
      return Checks.new(verdict: :indeterminate) unless latest.all? { |run| PASSING.include?(run["conclusion"]) }

      Checks.new(verdict: :green)
    end

    # Re-runs of the same workflow on the same SHA must not count as failures
    # once a later attempt has passed.
    def latest_per_workflow(runs)
      runs.group_by { |run| [run["workflowName"], run["event"]] }
          .values
          .map { |group| group.max_by { |run| [run["attempt"].to_i, run["createdAt"].to_s] } }
    end

    def handle_failure(ledger, entry, head, run)
      name = entry["heal_branch"]
      if entry["attempts"] >= config.max_heal_attempts_per_lineage
        if entry["state"] != "EXHAUSTED"
          ledger.transition!(name, "EXHAUSTED")
          log.warn("heal attempts exhausted; human review needed", heal_branch: name, attempts: entry["attempts"])
        end
        return
      end

      if entry["last_attempted_sha"] == head
        log.info("already spent an attempt on this head; waiting for a new commit", heal_branch: name, head: short(head))
        return
      end

      heal_in_place(ledger, entry, head, run)
    end

    def heal_in_place(ledger, entry, head, run)
      name = entry["heal_branch"]
      attempt = entry["attempts"] + 1
      run_id = run["databaseId"]
      worktree = worktree_path(run_id, head)

      digest = logs.digest_for(run_id)
      ledger.update!(name, attempts: attempt, last_attempted_sha: head)
      ledger.transition!(name, "HEALING")

      git.remove_worktree(worktree)
      git.add_detached_worktree(worktree, "origin/#{name}")
      if git.remote_head(name) != head
        log.warn("heal branch moved after the failure was observed; not touching it", heal_branch: name)
      elsif attempt_fix(worktree, run: run, digest: digest, attempt: attempt, base: entry["base_branch"]) == :committed
        git.push(worktree, "HEAD:refs/heads/#{name}")
        ledger.update!(name, last_pushed_sha: git.head_sha(worktree))
        log.info("pushed in-place fix", heal_branch: name, attempt: attempt, max: config.max_heal_attempts_per_lineage)
      end
      ledger.transition!(name, "PR_OPEN")
    rescue CommandError, TimeoutError, ProtocolError => e
      ledger.transition!(name, "PR_OPEN") if entry["state"] == "HEALING"
      log.error("in-place heal failed; attempt consumed", heal_branch: name, error: e.message)
    ensure
      git.remove_worktree(worktree) if worktree
    end

    # ── new failures ─────────────────────────────────────────────────────────

    def evaluate(ledger, default_branch)
      open_prs = github.open_pull_requests
      github.failed_runs(config.run_scan_limit).map do |run|
        verdict_for(run, ledger, default_branch, open_prs)
      end
    end

    def verdict_for(run, ledger, default_branch, open_prs)
      branch = run["headBranch"]
      target = Policy.target_for(branch, default_branch: default_branch, open_prs: open_prs)
      return Verdict.new(run: run, candidate: nil, reason: target.reason) unless target.ok?

      head = git.remote_head(branch)
      return skip(run, "branch not present on origin") unless head
      return skip(run, "stale: run #{short(run["headSha"])} is not the branch head #{short(head)}") unless head == run["headSha"]
      return skip(run, "already handled #{target.base}@#{short(head)}") if ledger.handled_head?(target.base, head)

      active = ledger.active_for_base(target.base).size
      return skip(run, "#{active} open agent lineage(s) against #{target.base}") if active >= config.max_open_prs_per_base

      candidate = Candidate.new(run: run, kind: target.kind, base: target.base, head: head)
      Verdict.new(run: run, candidate: candidate, reason: nil)
    end

    def skip(run, reason)
      Verdict.new(run: run, candidate: nil, reason: reason)
    end

    def heal_new(ledger, candidate)
      run = candidate.run
      run_id = run["databaseId"]
      base = candidate.base
      head = candidate.head
      branch = Policy.heal_branch_name(base, run_id)
      worktree = worktree_path(run_id, head)

      # Log fetch happens before any state change. A transient failure here just
      # retries on the next tick, and the failing SHA is not marked handled.
      digest = begin
        logs.digest_for(run_id)
      rescue CommandError, TimeoutError => e
        log.warn("could not fetch failed logs; retrying next tick", run: run_id, error: e.message)
        return
      end

      ledger.mark_head!(base, head, "HEALING")
      git.remove_worktree(worktree)
      git.add_branch_worktree(worktree, branch, "origin/#{base}")
      setup(worktree)

      if attempt_fix(worktree, run: run, digest: digest, attempt: 1, base: base) == :committed
        git.push(worktree, branch, set_upstream: true)
        pr_number = github.create_draft_pull_request(base: base, head: branch, title: pr_title(run, base), body: pr_body(run, base, head))
        ledger.add_lineage!(heal_branch: branch, base_branch: base, origin_run_id: run_id,
                            origin_sha: head, pr_number: pr_number, attempts: 1)
        ledger.mark_head!(base, head, "PR_OPEN")
        log.info("opened draft fix PR", pr: pr_number, heal_branch: branch, base: base)
      else
        ledger.mark_head!(base, head, "NO_PATCH")
        log.info("no patch landed; head not retried", run: run_id, base: base, head: short(head))
      end
    rescue CommandError, TimeoutError, ProtocolError => e
      ledger.mark_head!(base, head, "ERRORED")
      log.error("heal failed; head marked ERRORED and needs a human reset", run: run_id, base: base, error: e.message)
    ensure
      cleanup(worktree, branch)
    end

    # ── shared attempt pipeline ──────────────────────────────────────────────

    # Returns :committed when a verified, policy-clean change is committed in the
    # worktree, and :no_patch otherwise. Nothing is pushed here.
    def attempt_fix(worktree, run:, digest:, attempt:, base:)
      goal = Prompt.build(repo: config.repo_slug, source_branch: base, workflow: run["workflowName"],
                          run_id: run["databaseId"], attempt: attempt,
                          max_attempts: config.max_heal_attempts_per_lineage, digest: digest)
      outcome = nexum.execute(workspace: worktree, goal: goal)
      return give_up("nexum did not complete", status: outcome.status, error: outcome.error) unless outcome.completed?
      return give_up("verification failed") unless verify(worktree)

      changed = git.stage_all_and_list(worktree)
      return give_up("no file changes") if changed.empty?
      return give_up("patch too large", files: changed.size, cap: config.max_changed_files) if changed.size > config.max_changed_files

      forbidden = Policy.forbidden_paths(changed, config.forbidden_paths)
      return give_up("patch touches forbidden paths", paths: forbidden) unless forbidden.empty?

      begin
        git.commit(worktree, commit_message(run))
      rescue CommandError => e
        return give_up("commit rejected by repository hooks", error: e.message.lines.first&.strip)
      end
      :committed
    rescue TimeoutError, ProtocolError => e
      give_up("nexum failed", error: e.message)
    end

    def give_up(reason, **fields)
      log.warn("no patch: #{reason}", **fields)
      :no_patch
    end

    def setup(worktree)
      config.setup_commands.each do |command|
        shell.run(["sh", "-c", command], chdir: worktree, timeout: config.setup_timeout_sec)
      end
    end

    def verify(worktree)
      config.verify_commands.all? do |command|
        result = shell.run(["sh", "-c", command], chdir: worktree, timeout: config.verify_timeout_sec, allow_failure: true)
        log.info("verify", command: command, status: result.status)
        result.ok?
      end
    rescue TimeoutError => e
      log.warn("verify timed out", error: e.message)
      false
    end

    def cleanup(worktree, branch)
      git.remove_worktree(worktree) if worktree
      git.delete_local_branch(branch) if branch
    end

    def worktree_path(run_id, head)
      File.join(config.worktree_base, "#{config.repo_name}-#{run_id}-#{short(head)}")
    end

    def commit_message(run)
      "fix(ci): auto-heal #{run["workflowName"]} failure from run #{run["databaseId"]}"
    end

    def pr_title(run, base)
      "fix(ci): heal #{run["workflowName"]} on #{base}"
    end

    def pr_body(run, base, head)
      verify_list = config.verify_commands.map { |command| "`#{command}`" }.join(", ")
      <<~MD
        Automated CI remediation by `ci-healer`.

        - Failed run: #{run["url"]} (#{run["workflowName"]}, run #{run["databaseId"]})
        - Target branch: `#{base}` at `#{short(head)}`
        - Verified locally before push: #{verify_list}
        - Opened as a draft. Not auto-merged; review the diff before marking it ready.

        _Generated by ci-healer_
      MD
    end

    def short(sha)
      sha.to_s[0, 7]
    end
  end
end
