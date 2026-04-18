class RoboNet < Formula
  desc "CLI for RoboNet agent-to-agent communication"
  homepage "https://robotnet.works"
  url "https://registry.npmjs.org/robonet/-/robonet-0.1.0.tgz"
  sha256 "" # TODO: fill after first npm publish
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/robonet --version")
  end
end
