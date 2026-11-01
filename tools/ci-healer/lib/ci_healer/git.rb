# frozen_string_literal: true

require "fileutils"

module CiHealer
  # Git operations against the operator's main checkout. Heal work happens only in
  # short-lived worktrees, so the main checkout's working tree is never touched.
  class Git
    RETRY_DELAYS = [2, 4, 8, 16].freeze
    # Failures that retrying cannot fix: rejected pushes, auth and permission errors.
    NON_RETRYABLE = /non-fast-forward|fetch first|rejected|authentication failed|permission denied|could not read username|protected branch|does not appear to be a git repository/i

    def initialize(shell:, repo_dir:, author:, log:, sleeper: ->(seconds) { sleep(seconds) }, timeout: 300)
      @shell = shell
      @repo_dir = repo_dir
      @author = author
      @log = log
      @sleeper = sleeper
      @timeout = timeout
    end

    def fetch
      with_network_retries(%w[git fetch --prune origin], cwd: @repo_dir)
    end

    # Commit SHA of origin/<branch>, or nil when the branch does not exist on origin.
    def remote_head(branch)
      result = run(["git", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/#{branch}^{commit}"],
                   cwd: @repo_dir, allow_failure: true)
      result.ok? ? result.stdout.strip : nil
    end

    def prune_worktrees
      run(%w[git worktree prune], cwd: @repo_dir, allow_failure: true)
    end

    def add_branch_worktree(path, branch, start_point)
      run(["git", "worktree", "add", "-b", branch, path, start_point], cwd: @repo_dir)
    end

    def add_detached_worktree(path, ref)
      run(["git", "worktree", "add", "--detach", path, ref], cwd: @repo_dir)
    end

    def remove_worktree(path)
      run(["git", "worktree", "remove", "--force", path], cwd: @repo_dir, allow_failure: true)
      FileUtils.rm_rf(path)
      prune_worktrees
    end

    def delete_local_branch(branch)
      run(["git", "branch", "-D", branch], cwd: @repo_dir, allow_failure: true)
    end

    # Stages everything in the worktree and returns the changed paths.
    def stage_all_and_list(path)
      run(%w[git add -A], cwd: path)
      run(%w[git diff --cached --name-only -z], cwd: path).stdout.split("\0")
    end

    def commit(path, message)
      run(["git", "commit", "-m", message], cwd: path, env: author_env)
    end

    def head_sha(path)
      run(%w[git rev-parse HEAD], cwd: path).stdout.strip
    end

    def push(path, refspec, set_upstream: false)
      argv = ["git", "push"]
      argv << "-u" if set_upstream
      argv.push("origin", refspec)
      with_network_retries(argv, cwd: path)
    end

    private

    def with_network_retries(argv, cwd:)
      attempts = 0
      begin
        run(argv, cwd: cwd)
      rescue CommandError => e
        raise if e.stderr.match?(NON_RETRYABLE) || attempts >= RETRY_DELAYS.size

        delay = RETRY_DELAYS.fetch(attempts)
        attempts += 1
        @log.warn("git network failure; retrying", command: argv.first(3).join(" "), delay: delay, attempt: attempts)
        @sleeper.call(delay)
        retry
      end
    end

    def author_env
      name = @author.fetch("name")
      email = @author.fetch("email")
      { "GIT_AUTHOR_NAME" => name, "GIT_AUTHOR_EMAIL" => email,
        "GIT_COMMITTER_NAME" => name, "GIT_COMMITTER_EMAIL" => email }
    end

    def run(argv, cwd:, env: {}, allow_failure: false, stdin: nil)
      @shell.run(argv, chdir: cwd, env: env, allow_failure: allow_failure, stdin: stdin, timeout: @timeout)
    end
  end
end
