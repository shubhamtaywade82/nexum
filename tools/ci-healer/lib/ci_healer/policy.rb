# frozen_string_literal: true

module CiHealer
  # Pure decision rules. No I/O, so every branch is unit-testable.
  module Policy
    MANAGED_PREFIX = "fix/ci-"

    Target = Struct.new(:kind, :base, :reason, keyword_init: true) do
      def ok?
        reason.nil?
      end
    end

    module_function

    # A failing run on the default branch heals against the default branch. A
    # failing run on another branch heals only when that branch has an open,
    # same-repo, non-draft PR. Any fix/ci-* branch is skipped here: those are
    # reconciled from the ledger, which is the only authority for them.
    def target_for(branch, default_branch:, open_prs:)
      return Target.new(kind: :default, base: default_branch) if branch == default_branch
      return skip("fix/ci-* branches are reconciled from the ledger only") if branch.start_with?(MANAGED_PREFIX)

      pr = open_prs.find { |candidate| candidate["headRefName"] == branch }
      return skip("no open PR for #{branch}") unless pr
      return skip("fork PR; the daemon cannot push to it") if pr["isCrossRepository"]
      return skip("draft PR; its author is still working") if pr["isDraft"]

      Target.new(kind: :feature, base: branch)
    end

    def skip(reason)
      Target.new(kind: nil, base: nil, reason: reason)
    end

    def heal_branch_name(base, run_id)
      "#{MANAGED_PREFIX}#{sanitize(base)}-#{run_id}"
    end

    def sanitize(name)
      name.gsub(%r{[^A-Za-z0-9._-]+}, "-").gsub(/\A-+|-+\z/, "")
    end

    # Paths the agent may never change, however green the result looks.
    def forbidden_paths(paths, patterns)
      paths.select do |path|
        patterns.any? { |pattern| File.fnmatch?(pattern, path, File::FNM_PATHNAME | File::FNM_DOTMATCH) }
      end
    end
  end
end
