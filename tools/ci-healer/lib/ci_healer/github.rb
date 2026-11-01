# frozen_string_literal: true

require "json"

module CiHealer
  # Wraps the gh CLI. Returns GitHub's own camelCase JSON shapes so fixtures in
  # tests look like real `gh --json` output. Every call is an argv array.
  class GitHub
    RUN_FIELDS = "databaseId,headBranch,headSha,workflowName,event,status,conclusion,attempt,createdAt,url"
    PR_FIELDS = "number,state,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft"

    def initialize(shell:, slug:, cwd:, timeout: 120)
      @shell = shell
      @slug = slug
      @cwd = cwd
      @timeout = timeout
    end

    def default_branch
      name = json(["gh", "repo", "view", @slug, "--json", "defaultBranchRef"]).dig("defaultBranchRef", "name")
      name || raise(ProtocolError, "gh repo view returned no default branch")
    end

    def failed_runs(limit)
      json(["gh", "run", "list", "-R", @slug, "--status", "failure", "--limit", limit.to_s, "--json", RUN_FIELDS])
    end

    def runs_for_branch(branch, limit: 30)
      json(["gh", "run", "list", "-R", @slug, "--branch", branch, "--limit", limit.to_s, "--json", RUN_FIELDS])
    end

    def open_pull_requests
      json(["gh", "pr", "list", "-R", @slug, "--state", "open", "--limit", "200", "--json", PR_FIELDS])
    end

    def pull_request(number)
      json(["gh", "pr", "view", number.to_s, "-R", @slug, "--json", PR_FIELDS])
    end

    def failed_log(run_id)
      run(["gh", "run", "view", run_id.to_s, "-R", @slug, "--log-failed"]).stdout
    end

    def create_draft_pull_request(base:, head:, title:, body:)
      argv = ["gh", "pr", "create", "-R", @slug, "--draft", "--base", base, "--head", head,
              "--title", title, "--body-file", "-"]
      output = run(argv, stdin: body).stdout
      url = output.lines.map(&:strip).reverse.find { |line| line.match?(%r{/pull/\d+\z}) }
      raise ProtocolError, "gh pr create printed no PR URL: #{output.strip[0, 200]}" unless url

      Integer(url[%r{/pull/(\d+)\z}, 1])
    end

    private

    def run(argv, stdin: nil)
      @shell.run(argv, chdir: @cwd, stdin: stdin, timeout: @timeout)
    end

    def json(argv)
      parsed = JSON.parse(run(argv).stdout)
      raise ProtocolError, "expected JSON object or array from #{argv.first(3).join(" ")}" unless parsed.is_a?(Hash) || parsed.is_a?(Array)

      parsed
    rescue JSON::ParserError => e
      raise ProtocolError, "non-JSON output from #{argv.first(3).join(" ")}: #{e.message}"
    end
  end
end
