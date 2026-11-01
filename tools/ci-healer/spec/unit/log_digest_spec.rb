# frozen_string_literal: true

RSpec.describe CiHealer::Digester do
  subject(:digester) { described_class.new(line_cap: 40, byte_cap: 800, context: 1, tail_lines: 5) }

  def gh_line(text, step: "Run tests", ts: "2026-11-01T05:48:00.1234567Z")
    "build\t#{step}\t#{ts} #{text}"
  end

  it "strips ANSI codes and the gh job/step/timestamp prefix" do
    raw = gh_line("\e[31mError: boom\e[0m in app/models/user.rb:12")
    expect(digester.digest(raw)).to eq("Error: boom in app/models/user.rb:12")
  end

  it "keeps failure lines with context and drops install noise" do
    raw = [
      gh_line("npm WARN deprecated left-pad@1.0.0"),
      gh_line("added 812 packages in 9s"),
      gh_line("Failures:"),
      gh_line("  1) User validates email"),
      gh_line("     Failure/Error: expect(user).to be_valid"),
      gh_line("     at ./spec/models/user_spec.rb:14"),
      gh_line("Finished in 0.3 seconds"),
      gh_line("cache restored"),
    ].join("\n")

    digest = digester.digest(raw)
    expect(digest).to include("Failure/Error")
    expect(digest).to include("user_spec.rb:14")
    expect(digest).not_to include("left-pad")
    expect(digest).not_to include("cache restored")
  end

  it "falls back to the tail of the log when nothing matches a failure signal" do
    raw = (1..20).map { |i| "step line #{i}" }.join("\n")
    expect(digester.digest(raw).lines.map(&:strip).last).to eq("step line 20")
  end

  it "caps very long digests and keeps both the head and the tail" do
    raw = (1..500).map { |i| "ERROR at line #{i} in lib/x.rb:#{i}" }.join("\n")
    digest = digester.digest(raw)
    expect(digest.bytesize).to be <= 800 + 60
    expect(digest).to include("ERROR at line 1 ")
    expect(digest).to include("ERROR at line 500 ")
  end

  it "replaces invalid UTF-8 instead of raising" do
    raw = "ERROR bad \xff\xfe bytes in lib/x.rb:3\n".dup.force_encoding(Encoding::BINARY)
    expect { digester.digest(raw) }.not_to raise_error
  end

  it "returns an empty digest for an empty log" do
    expect(digester.digest("\n\n")).to eq("")
  end
end

RSpec.describe CiHealer::LogSource do
  let(:github) { FakeGitHub.new }
  let(:log_io) { StringIO.new }
  let(:log) { CiHealer::Log.new(io: log_io) }

  it "uses the deterministic digest when no condenser is configured" do
    github.logs[5] = "ERROR: kaboom in lib/a.rb:1\n"
    source = described_class.new(github: github, digester: CiHealer::Digester.new, log: log)
    expect(source.digest_for(5)).to include("kaboom")
  end

  it "falls back to the deterministic digest when the condenser is unavailable" do
    github.logs[5] = "ERROR: kaboom in lib/a.rb:1\n"
    condenser = double("condenser")
    allow(condenser).to receive(:condense).and_raise(CiHealer::CondenserError, "ollama unreachable")
    source = described_class.new(github: github, digester: CiHealer::Digester.new, log: log, condenser: condenser)

    expect(source.digest_for(5)).to include("kaboom")
    expect(log_io.string).to include("condenser unavailable")
  end
end
