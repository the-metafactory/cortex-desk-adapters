import { describe, expect, test } from "bun:test";
import { resolveImapSource, UsageError } from "../src/imap-mail";
import type { Runner } from "../src/run";

const run: Runner = async () => ({ code: 1, stdout: "", stderr: "" });
const file = JSON.stringify({
  accounts: { work: { imap: { enabled: true, host: "imap.example.org", port: 993, tls: true, auth: { user: "sam@example.org", pass: "s3cret" } } } },
});
const readConfig = async () => file;

describe("desk-imap account resolution", () => {
  test("takes host, port, TLS, user and secret from the config account", async () => {
    const source = await resolveImapSource({ config: "/mail.json", account: "work" }, { readConfig, run });
    expect(source).toEqual({ account: "work", host: "imap.example.org", port: 993, secure: true, starttls: false, user: "sam@example.org", pass: "s3cret" });
  });

  test("the flag route works unchanged", async () => {
    const source = await resolveImapSource({ host: "h.example.org", user: "u", account: "personal" }, { env: { DESK_IMAP_PASSWORD: "pw" } });
    expect(source).toEqual({ account: "personal", host: "h.example.org", port: 993, secure: true, starttls: false, user: "u", pass: "pw" });
    expect((await resolveImapSource({ host: "h", user: "u", starttls: true, port: "143", "password-env": "X" }, { env: { X: "p" } })).account).toBe("mail");
  });

  test("--config with --host or --user is a usage error", async () => {
    for (const extra of [{ host: "h" }, { user: "u" }]) {
      const err = await resolveImapSource({ config: "/mail.json", account: "work", ...extra }, { readConfig, run }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageError);
      expect((err as Error).message).toBe("Use --config or --host and --user, not both.");
    }
  });

  test("an account the file does not hold is refused", async () => {
    await expect(resolveImapSource({ config: "/mail.json", account: "home" }, { readConfig, run })).rejects.toThrow("There is no home account in the mail config.");
  });

  test("an unreadable config is refused", async () => {
    await expect(resolveImapSource({ config: "/nonexistent.json", account: "x" }, { readConfig: async () => { throw new Error("no"); }, run })).rejects.toThrow("The mail config could not be read.");
  });
});
