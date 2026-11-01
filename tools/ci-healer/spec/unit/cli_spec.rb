# frozen_string_literal: true

RSpec.describe CiHealer::CLI do
  let(:dir) { Dir.mktmpdir("cli-spec") }
  let(:log) { CiHealer::Log.new(io: StringIO.new) }
  let(:repo_dir) { File.join(dir, "repo") }

  before { FileUtils.mkdir_p(File.join(repo_dir, ".git")) }
  after { FileUtils.rm_rf(dir) }

  def write_config(extra = {})
    path = File.join(dir, "config.json")
    File.write(path, JSON.generate({
      "repo" => { "slug" => "acme/app", "dir" => repo_dir },
      "verify_commands" => ["make test"],
      "state_file" => File.join(dir, "state.json"),
      "kill_switch_file" => File.join(dir, "DISABLED"),
      "worktree_base" => File.join(dir, "wt")
    }.merge(extra)))
    path
  end

  it "exits 0 without touching GitHub when the kill switch is present" do
    FileUtils.touch(File.join(dir, "DISABLED"))
    shell = instance_double(CiHealer::Shell)
    expect(shell).not_to receive(:run)

    expect(described_class.main(["--config", write_config], log: log, shell: shell)).to eq(0)
  end

  it "exits 2 when --config is missing" do
    expect(described_class.main([], log: log)).to eq(2)
  end

  it "exits 2 on an invalid config, so cron surfaces it as an operator problem" do
    expect(described_class.main(["--config", write_config("verify_commands" => [])], log: log)).to eq(2)
  end

  it "exits 2 on a corrupt ledger instead of running against an empty one" do
    File.write(File.join(dir, "state.json"), "{")
    shell = instance_double(CiHealer::Shell)
    expect(described_class.main(["--config", write_config], log: log, shell: shell)).to eq(2)
  end
end
