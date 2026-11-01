# frozen_string_literal: true

require "tmpdir"
require "stringio"
require "fileutils"
require "rbconfig"
require "open3"

$LOAD_PATH.unshift(File.expand_path("../lib", __dir__))
require "ci_healer"

Dir[File.expand_path("support/**/*.rb", __dir__)].sort.each { |file| require file }

RSpec.configure do |config|
  config.disable_monkey_patching!
  config.expect_with(:rspec) { |expectations| expectations.syntax = :expect }
end
