# frozen_string_literal: true

RSpec.describe CiHealer::Ledger do
  let(:dir) { Dir.mktmpdir("ledger-spec") }
  let(:path) { File.join(dir, "state.json") }

  after { FileUtils.rm_rf(dir) }

  def add_lineage(ledger, name: "fix/ci-main-1", pr: 1)
    ledger.add_lineage!(heal_branch: name, base_branch: "main", origin_run_id: 1,
                        origin_sha: "a" * 40, pr_number: pr, attempts: 1)
  end

  it "starts empty when no ledger file exists and persists on first mutation" do
    ledger = described_class.load(path)
    expect(ledger.active_lineages).to be_empty
    expect(File.exist?(path)).to be false

    add_lineage(ledger)
    expect(described_class.load(path).lineage("fix/ci-main-1")).to include("state" => "PR_OPEN", "pr_number" => 1)
  end

  it "refuses to run on a corrupt ledger instead of forgetting handled failures" do
    File.write(path, "{ not json")
    expect { described_class.load(path) }.to raise_error(CiHealer::StateError, /corrupt/)
  end

  it "refuses an unknown format version" do
    File.write(path, JSON.generate({ version: 99, lineages: {}, handled_heads: {} }))
    expect { described_class.load(path) }.to raise_error(CiHealer::StateError, /unexpected shape/)
  end

  it "rejects illegal lineage transitions" do
    ledger = described_class.load(path)
    add_lineage(ledger)
    ledger.transition!("fix/ci-main-1", "CLOSED", pr_state: "MERGED")

    expect { ledger.transition!("fix/ci-main-1", "PR_OPEN") }
      .to raise_error(CiHealer::StateError, /illegal transition CLOSED -> PR_OPEN/)
  end

  it "treats a same-state transition as an attribute update" do
    ledger = described_class.load(path)
    add_lineage(ledger)
    ledger.transition!("fix/ci-main-1", "PR_OPEN", note: "still open")
    expect(ledger.lineage("fix/ci-main-1")).to include("state" => "PR_OPEN", "note" => "still open")
  end

  it "moves a crash-interrupted HEALING lineage back to PR_OPEN on recovery" do
    ledger = described_class.load(path)
    add_lineage(ledger)
    ledger.transition!("fix/ci-main-1", "HEALING")

    expect(ledger.recover_interrupted!).to eq(["fix/ci-main-1"])
    expect(ledger.lineage("fix/ci-main-1")["state"]).to eq("PR_OPEN")
  end

  it "tracks active lineages per base branch and excludes closed ones" do
    ledger = described_class.load(path)
    add_lineage(ledger, name: "fix/ci-main-1", pr: 1)
    add_lineage(ledger, name: "fix/ci-main-2", pr: 2)
    ledger.transition!("fix/ci-main-2", "CLOSED", pr_state: "MERGED")

    expect(ledger.active_for_base("main").map { |l| l["heal_branch"] }).to eq(["fix/ci-main-1"])
    expect(ledger.active_for_base("other")).to be_empty
  end

  it "records handled heads per base and sha" do
    ledger = described_class.load(path)
    ledger.mark_head!("main", "abc", "NO_PATCH")
    expect(ledger.handled_head?("main", "abc")).to be true
    expect(ledger.handled_head?("main", "def")).to be false
    expect(ledger.handled_outcome("main", "abc")).to eq("NO_PATCH")
  end

  it "bounds the handled-head history" do
    ledger = described_class.load(path)
    (CiHealer::Ledger::HANDLED_CAP + 5).times { |i| ledger.mark_head!("main", format("%040d", i), "NO_PATCH") }

    reloaded = described_class.load(path)
    expect(reloaded.handled_head?("main", format("%040d", 0))).to be false
    expect(reloaded.handled_head?("main", format("%040d", CiHealer::Ledger::HANDLED_CAP + 4))).to be true
  end

  it "raises LockHeld when another process holds the lock" do
    described_class.with_lock(path) do
      expect { described_class.with_lock(path) { :never } }.to raise_error(CiHealer::LockHeld)
    end
  end

  it "leaves no temp files behind after a successful write" do
    ledger = described_class.load(path)
    add_lineage(ledger)
    expect(Dir.children(dir).grep(/tmp/)).to be_empty
  end
end
