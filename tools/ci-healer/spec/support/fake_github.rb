# frozen_string_literal: true

# In-memory stand-in for CiHealer::GitHub. Tests set the fixtures directly, using
# GitHub's own JSON field names.
class FakeGitHub
  attr_accessor :default, :failed, :open_prs, :pulls, :logs
  attr_reader :branch_runs, :created

  def initialize(default: "main")
    @default = default
    @failed = []
    @open_prs = []
    @branch_runs = Hash.new { |hash, key| hash[key] = [] }
    @pulls = {}
    @logs = {}
    @created = []
    @next_number = 0
  end

  def default_branch
    @default
  end

  def failed_runs(_limit)
    @failed
  end

  def open_pull_requests
    @open_prs
  end

  def runs_for_branch(branch, limit: 30)
    @branch_runs[branch].first(limit)
  end

  def pull_request(number)
    @pulls.fetch(number) { raise CiHealer::ProtocolError, "no fixture for PR #{number}" }
  end

  def failed_log(run_id)
    @logs.fetch(run_id, "build\tRun tests\t2026-11-01T00:00:00.0000000Z ##[error]Process completed with exit code 1.\n")
  end

  def create_draft_pull_request(base:, head:, title:, body:)
    @next_number += 1
    @created << { number: @next_number, base: base, head: head, title: title, body: body }
    @next_number
  end
end
