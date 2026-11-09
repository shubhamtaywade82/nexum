import { isSensitivePath } from "../../src/safety/path-policy.js";

describe("isSensitivePath", () => {
  it.each([
    ".env",
    "config/.env.production",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
    "keys/server.pem",
    ".ssh/config",
    "home/.aws/credentials",
    "home/.gnupg/secring.gpg",
    "app/secrets/token.txt",
  ])("flags %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  // Case variants resolve to the same files on case-insensitive volumes (macOS, Windows).
  it.each([
    "ID_RSA",
    "Id_Ed25519",
    "Credentials.json",
    "CREDENTIALS.JSON",
    ".AWS/credentials",
    ".Ssh/known_hosts",
    "home/.GNUPG/secring.gpg",
    ".ENV",
    "SECRETS/token.txt",
    "KEY.PEM",
  ])("flags case variant %s", (path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each(["src/index.ts", "README.md", "docs/aws-setup.md", "config/keyboard.ts", "sshd_config.md"])(
    "leaves ordinary path %s alone",
    (path) => {
      expect(isSensitivePath(path)).toBe(false);
    },
  );
});
