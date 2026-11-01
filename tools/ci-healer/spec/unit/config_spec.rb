# frozen_string_literal: true

RSpec.describe CiHealer::Config do
  let(:repo_dir) { Dir.mktmpdir("config-spec") }

  before { FileUtils.mkdir_p(File.join(repo_dir, ".git")) }
  after { FileUtils.rm_rf(repo_dir) }

  def base_config(overrides = {})
    {
      "repo" => { "slug" => "acme/app", "dir" => repo_dir },
      "verify_commands" => ["bundle exec rspec"]
    }.merge(overrides)
  end

  it "applies defaults, including the mandatory forbidden paths" do
    config = described_class.new(base_config)
    expect(config.max_heal_attempts_per_lineage).to eq(3)
    expect(config.forbidden_paths).to include(".github/workflows/**")
    expect(config.repo_name).to eq("app")
  end

  it "refuses to start without verify commands, so unverified patches are never pushed" do
    expect { described_class.new(base_config("verify_commands" => [])) }
      .to raise_error(CiHealer::ConfigError, /unverified patches/)
  end

  it "rejects a repo slug that is not owner/name" do
    expect { described_class.new(base_config("repo" => { "slug" => "app", "dir" => repo_dir })) }
      .to raise_error(CiHealer::ConfigError, /owner\/name/)
  end

  it "rejects a repo directory that is not a git checkout" do
    expect { described_class.new(base_config("repo" => { "slug" => "acme/app", "dir" => "/nonexistent-#{rand(1_000_000)}" })) }
      .to raise_error(CiHealer::ConfigError, /not a git checkout/)
  end

  it "rejects attempt budgets outside 1..10" do
    expect { described_class.new(base_config("max_heal_attempts_per_lineage" => 0)) }
      .to raise_error(CiHealer::ConfigError, /between 1 and 10/)
  end

  it "requires a model for the ollama condenser" do
    expect { described_class.new(base_config("condenser" => { "type" => "ollama" })) }
      .to raise_error(CiHealer::ConfigError, /model is required/)
  end

  it "raises ConfigError for a missing file or invalid JSON" do
    expect { described_class.load("/no/such/config.json") }.to raise_error(CiHealer::ConfigError, /not found/)

    path = File.join(repo_dir, "bad.json")
    File.write(path, "{")
    expect { described_class.load(path) }.to raise_error(CiHealer::ConfigError, /not valid JSON/)
  end
end
