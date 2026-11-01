# frozen_string_literal: true

# Builds a real bare "origin" and a working clone, so integration tests exercise
# genuine worktree, commit, and push behavior.
module GitFixture
  IDENTITY = {
    "GIT_AUTHOR_NAME" => "fixture", "GIT_AUTHOR_EMAIL" => "fixture@example.test",
    "GIT_COMMITTER_NAME" => "fixture", "GIT_COMMITTER_EMAIL" => "fixture@example.test"
  }.freeze

  def git!(*args, chdir: nil)
    out, err, status = Open3.capture3(IDENTITY, "git", *args, chdir: chdir || Dir.pwd)
    raise "git #{args.join(" ")} failed: #{err}" unless status.success?

    out.strip
  end

  # Returns { origin:, seed:, work: }. origin is bare; seed publishes commits; work is
  # the clone the healer operates on.
  def build_origin_and_clone(root)
    origin = File.join(root, "origin.git")
    seed = File.join(root, "seed")
    work = File.join(root, "work")

    git!("init", "--bare", "-q", "-b", "main", origin)
    git!("init", "-q", "-b", "main", seed)
    git!("remote", "add", "origin", origin, chdir: seed)
    publish(seed, branch: "main", file: "README.md", content: "app\n", base: nil)
    git!("clone", "-q", origin, work)
    { origin: origin, seed: seed, work: work }
  end

  # Commits `content` to `file` on `branch` (created from `base` when given) and pushes it.
  def publish(seed, branch:, file:, content:, base: "main")
    git!("checkout", "-q", "-B", branch, *[base].compact, chdir: seed)
    path = File.join(seed, file)
    FileUtils.mkdir_p(File.dirname(path))
    File.write(path, content)
    git!("add", "-A", chdir: seed)
    git!("commit", "-q", "-m", "#{branch}: #{file}", chdir: seed)
    git!("push", "-q", "-f", "origin", branch, chdir: seed)
    git!("rev-parse", "HEAD", chdir: seed)
  end
end
