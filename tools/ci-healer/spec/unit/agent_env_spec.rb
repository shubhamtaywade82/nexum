# frozen_string_literal: true

RSpec.describe CiHealer::AgentEnv do
  let(:source) do
    {
      "PATH" => "/usr/bin", "HOME" => "/home/u", "LANG" => "en_US.UTF-8", "LC_ALL" => "C",
      "GH_TOKEN" => "gh-secret", "GITHUB_TOKEN" => "gh-secret-2", "NEXUM_GITHUB_TOKEN" => "x",
      "SSH_AUTH_SOCK" => "/tmp/agent.sock", "GIT_ASKPASS" => "/usr/bin/askpass",
      "NEXUM_MODEL" => "qwen", "OLLAMA_API_KEY" => "model-key", "FOO" => "bar"
    }
  end

  describe ".agent" do
    it "keeps PATH, locale, and model configuration including provider keys" do
      env = described_class.agent(source)
      expect(env).to include("PATH" => "/usr/bin", "LC_ALL" => "C", "NEXUM_MODEL" => "qwen", "OLLAMA_API_KEY" => "model-key")
    end

    it "never passes GitHub or SSH credentials, even through NEXUM_ or an explicit allow" do
      env = described_class.agent(source, allow: %w[GH_TOKEN SSH_AUTH_SOCK])
      expect(env.keys).not_to include("GH_TOKEN", "GITHUB_TOKEN", "NEXUM_GITHUB_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS")
    end

    it "drops unrelated variables unless explicitly allowed" do
      expect(described_class.agent(source).keys).not_to include("FOO")
      expect(described_class.agent(source, allow: ["FOO"])).to include("FOO" => "bar")
    end
  end

  describe ".repo_command" do
    it "gives repo-controlled commands no model keys and no GitHub or SSH credentials" do
      env = described_class.repo_command(source)
      expect(env).to include("PATH" => "/usr/bin")
      expect(env.keys).not_to include("OLLAMA_API_KEY", "NEXUM_MODEL", "GH_TOKEN", "SSH_AUTH_SOCK")
    end
  end
end

RSpec.describe "credential isolation in child processes" do
  let(:shell) { CiHealer::Shell.new }
  let(:fixture) { File.expand_path("../fixtures/fake_nexum.rb", __dir__) }
  let(:workspace) { Dir.mktmpdir("env-spec") }
  let(:log) { CiHealer::Log.new(io: StringIO.new) }

  around do |example|
    saved = ENV.to_h.slice("GH_TOKEN", "OLLAMA_API_KEY", "FAKE_NEXUM")
    ENV["GH_TOKEN"] = "leak-me"
    ENV["OLLAMA_API_KEY"] = "model-key"
    ENV["FAKE_NEXUM"] = "env"
    example.run
  ensure
    ENV.delete("GH_TOKEN")
    ENV.delete("OLLAMA_API_KEY")
    ENV.delete("FAKE_NEXUM")
    saved.each { |key, value| ENV[key] = value }
    FileUtils.rm_rf(workspace)
  end

  it "runs verify-style commands without GH_TOKEN, even when the daemon has it" do
    result = shell.run(["sh", "-c", 'printf %s "${GH_TOKEN-unset}"'],
                       env: CiHealer::AgentEnv.repo_command(ENV), clean_env: true)
    expect(result.stdout).to eq("unset")
  end

  it "gives the agent model configuration but not GH_TOKEN" do
    client = CiHealer::NexumClient.new(command: [RbConfig.ruby, fixture], timeout: 20, log: log,
                                       env: CiHealer::AgentEnv.agent(ENV, allow: ["FAKE_NEXUM"]))
    outcome = client.execute(workspace: workspace, goal: "report credentials")
    expect(outcome.output).to eq("GH=absent OLLAMA=model-key")
  end
end
