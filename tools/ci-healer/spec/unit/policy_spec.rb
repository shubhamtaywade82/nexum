# frozen_string_literal: true

RSpec.describe CiHealer::Policy do
  let(:open_pr) do
    { "number" => 7, "headRefName" => "feature/x", "baseRefName" => "main",
      "isCrossRepository" => false, "isDraft" => false }
  end

  describe ".target_for" do
    it "targets the default branch for failures on the default branch" do
      target = described_class.target_for("main", default_branch: "main", open_prs: [])
      expect(target).to have_attributes(ok?: true, kind: :default, base: "main")
    end

    it "targets the failing branch when it has an open same-repo non-draft PR" do
      target = described_class.target_for("feature/x", default_branch: "main", open_prs: [open_pr])
      expect(target).to have_attributes(ok?: true, kind: :feature, base: "feature/x")
    end

    it "skips branches with no open PR" do
      target = described_class.target_for("feature/x", default_branch: "main", open_prs: [])
      expect(target.reason).to match(/no open PR/)
    end

    it "skips fork PRs because the daemon cannot push to them" do
      target = described_class.target_for("feature/x", default_branch: "main",
                                          open_prs: [open_pr.merge("isCrossRepository" => true)])
      expect(target.reason).to match(/fork PR/)
    end

    it "skips draft PRs whose author is still working" do
      target = described_class.target_for("feature/x", default_branch: "main",
                                          open_prs: [open_pr.merge("isDraft" => true)])
      expect(target.reason).to match(/draft PR/)
    end

    it "never targets fix/ci-* branches directly, even when they have an open PR" do
      pr = open_pr.merge("headRefName" => "fix/ci-main-111")
      target = described_class.target_for("fix/ci-main-111", default_branch: "main", open_prs: [pr])
      expect(target.reason).to match(/ledger/)
    end
  end

  describe ".heal_branch_name" do
    it "builds fix/ci-<base>-<run> for the default branch" do
      expect(described_class.heal_branch_name("main", 111)).to eq("fix/ci-main-111")
    end

    it "sanitizes slashes in feature branch names" do
      expect(described_class.heal_branch_name("feat/payments retry", 9)).to eq("fix/ci-feat-payments-retry-9")
    end
  end

  describe ".forbidden_paths" do
    let(:patterns) { [".github/workflows/**", "**/.env", "**/.env.*", "**/*.pem"] }

    it "flags CI workflow edits, env files, and key material" do
      flagged = described_class.forbidden_paths(
        [".github/workflows/ci.yml", "app/.env", "config/.env.production", "certs/server.pem"], patterns
      )
      expect(flagged).to eq([".github/workflows/ci.yml", "app/.env", "config/.env.production", "certs/server.pem"])
    end

    it "leaves ordinary source files alone" do
      expect(described_class.forbidden_paths(["lib/app.rb", "README.md", ".envrc"], patterns)).to be_empty
    end
  end
end
