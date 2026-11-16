import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccountRecord, readMailConfig, resolvePassword } from "../src/mail-config";
import type { Runner } from "../src/run";

describe("shared config reader", () => {
  test("injects the reader, preserves the default path and account casing", async () => {
    const paths: string[] = [];
    const account = { imap: { enabled: true } };
    const read = async (path: string) => {
      paths.push(path);
      return JSON.stringify({ defaultAccount: "Work", accounts: { Work: account } });
    };
    expect(await readMailConfig(undefined, read)).toEqual({ defaultAccount: "Work", accounts: { Work: account } });
    expect(await mailAccountRecord("wOrK", "/custom/mail.json", read)).toEqual(account);
    expect(paths).toEqual([join(homedir(), ".config", "email", "config.json"), "/custom/mail.json"]);
    await expect(mailAccountRecord("home", "/custom/mail.json", read)).rejects.toThrow("There is no home account in the mail config.");
  });

  test("refuses missing, unreadable and invalid JSON with the same sentence", async () => {
    await expect(readMailConfig("/mail.json", async () => "{invalid")).rejects.toThrow("The mail config could not be read.");
    for (const code of ["ENOENT", "EACCES"]) {
      await expect(readMailConfig("/mail.json", async () => { throw Object.assign(new Error("private path"), { code }); })).rejects.toThrow("The mail config could not be read.");
    }
    await expect(readMailConfig("/mail.json", async () => "{")).rejects.toThrow("The mail config could not be read.");
    for (const value of [null, [], {}, { accounts: [] }]) {
      expect(await readMailConfig("/mail.json", async () => JSON.stringify(value))).toEqual({ accounts: {} });
    }
  });

  test("resolves literal, environment and keychain secrets through an injected runner", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => { calls.push(argv); return { code: 0, stdout: "secret\n", stderr: "" }; };
    expect(await resolvePassword("literal", run)).toBe("literal");
    expect(await resolvePassword("env:MAIL_PASS", run, { MAIL_PASS: "env-secret" })).toBe("env-secret");
    expect(await resolvePassword("keychain:test-service", run)).toBe("secret");
    expect(calls).toEqual([["security", "find-generic-password", "-s", "test-service", "-w"]]);
    await expect(resolvePassword("env:MISSING", run, {})).rejects.toThrow("environment variable is not set");
    await expect(resolvePassword("keychain:missing", async () => ({ code: 44, stdout: "", stderr: "" }))).rejects.toThrow("could not be read from the keychain");
  });
});

const messageId = "message@example.org";
const requests = {
  move: { action: "move", account: "work", messageId, target: "archive" },
  trash: { action: "trash", account: "work", messageId },
  report: { action: "report", account: "work", messageId, to: "report@example.org" },
  dmarc: { action: "dmarc", account: "work", messageId },
  invite: { action: "invite-reply", account: "work", messageId, uid: "meeting-1", reply: "accept", requestId: "request-0001" },
  send: { subject: "Example", body: "Mail body" },
};
type Command = keyof typeof requests;
const commands = Object.keys(requests) as Command[];
const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:meeting-1", "DTSTART:20261120T140000Z", "DTEND:20261120T150000Z", "SUMMARY:Meeting", "ORGANIZER:mailto:organizer@example.org", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:work@example.org", "END:VEVENT", "END:VCALENDAR"].join("\r\n");

describe("mail command config arguments", () => {
  let dir: string;
  const logPath = () => join(dir, "imap.jsonl");
  const config = (host: string, tls = true, pass = "env:MAIL_TEST_PASSWORD") => ({
    defaultAccount: "Work",
    accounts: { Work: {
      from: { email: "work@example.org" },
      smtp: { host: `smtp.${host}`, port: 587, secure: false, auth: { user: "smtp-user", pass } },
      imap: { enabled: true, host, port: 1993, tls, auth: { user: "imap-user@example.org", pass } },
    } },
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mail-config-test-"));
    await mkdir(join(dir, ".config", "email"), { recursive: true });
    await writeFile(join(dir, ".config", "email", "config.json"), JSON.stringify(config("default.example.org")));
    await writeFile(join(dir, "custom.json"), JSON.stringify(config("custom.example.org")));
    await mkdir(join(dir, "fake-bin"));
    await writeFile(join(dir, "fake-bin", "curl"), '#!/bin/sh\ncat > "$MAIL_TEST_CURL"\n', { mode: 0o755 });
    await writeFile(join(dir, "fake-bin", "security"), '#!/bin/sh\nprintf "keychain-secret\\n"\n', { mode: 0o755 });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = async (command: Command, args: string[], request: unknown = requests[command]) => {
    const child = Bun.spawn([process.execPath, "--preload", join(import.meta.dir, "fixtures", "mail-config-imap.ts"), join(import.meta.dir, "..", "bin", `desk-mail-${command}.ts`), ...args], {
      env: { HOME: dir, PATH: `${join(dir, "fake-bin")}:/usr/bin:/bin`, XDG_STATE_HOME: join(dir, "state"), MAIL_TEST_LOG: logPath(), MAIL_TEST_CURL: join(dir, "curl.txt"), MAIL_TEST_PASSWORD: "env-secret", MAIL_TEST_ICS: ics },
      stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const events = async (): Promise<{ event: string; value: any }[]> => (await readFile(logPath(), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

  for (const command of commands) {
    for (const source of ["missing.json", ".config"]) {
      test(`${command} refuses an unreadable --config (${source}) before mailbox or SMTP access`, async () => {
        const result = await run(command, ["--config", join(dir, source)]);
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim().split("\n").at(-1)).toBe("The mail config could not be read.");
        expect(await events()).toEqual([]);
        expect(await Bun.file(join(dir, "curl.txt")).exists()).toBe(false);
      });
    }

    for (const custom of [true, false]) {
      test(`${command} uses ${custom ? "--config" : "the legacy default path"} alongside existing flags`, async () => {
        if (custom) await rm(join(dir, ".config", "email", "config.json"));
        const args = custom ? ["--config", join(dir, "custom.json")] : [];
        if (command !== "send") args.push("--mailbox", "CustomInbox");
        else {
          await writeFile(join(dir, "request.json"), JSON.stringify(requests.send));
          args.push("--request-file", join(dir, "request.json"));
        }
        const result = await run(command, args);
        // This fake mail has a calendar part, not a DMARC report, so the reader refuses it after connecting.
        expect({ code: result.code, stderr: result.stderr }).toEqual(command === "dmarc" ? { code: 3, stderr: expect.stringContaining("attachment") } : { code: 0, stderr: "" });
        const host = custom ? "custom.example.org" : "default.example.org";
        if (command !== "send") {
          const log = await events();
          expect(log.find((e) => e.event === "connect")?.value).toMatchObject({ host, port: 1993, secure: true, auth: { user: "imap-user@example.org", pass: "env-secret" } });
          expect(log.find((e) => e.event === "open")?.value.path).toBe("CustomInbox");
          if (command === "move" || command === "trash") expect(log.find((e) => e.event === "move")?.value).toEqual({ uids: [7], target: command === "move" ? "Archive" : "Trash" });
          if (command === "report") expect(log.find((e) => e.event === "append")?.value.content).toContain("From: imap-user@example.org");
        }
        if (command === "send" || command === "invite") {
          const curl = await readFile(join(dir, "curl.txt"), "utf8");
          expect(curl).toContain(`smtp://smtp.${host}:587`);
          expect(curl).toContain('user = "smtp-user:env-secret"');
          expect(curl).toContain(`mail-rcpt = "${command === "send" ? "work@example.org" : "organizer@example.org"}"`);
        }
      });
    }
  }

  test("move applies STARTTLS, the alternate port and a resolved keychain secret", async () => {
    await writeFile(join(dir, "custom.json"), JSON.stringify(config("starttls.example.org", false, "keychain:test-service")));
    const result = await run("move", ["--config", join(dir, "custom.json")]);
    expect(result.code).toBe(0);
    expect((await events()).find((e) => e.event === "connect")?.value).toMatchObject({ host: "starttls.example.org", port: 1993, secure: false, doSTARTTLS: true, auth: { user: "imap-user@example.org", pass: "keychain-secret" } });
  });

  test("cached invitation replies still validate an explicit config, while legacy retries keep working", async () => {
    const path = join(dir, "custom.json");
    expect((await run("invite", ["--config", path])).code).toBe(0);
    const before = await events();
    await rm(path);
    const missing = await run("invite", ["--config", path]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.trim()).toBe("The mail config could not be read.");
    await writeFile(path, '{"accounts":{}}');
    const absent = await run("invite", ["--config", path]);
    expect(absent.code).toBe(1);
    expect(absent.stderr.trim()).toBe("There is no work account in the mail config.");
    await rm(join(dir, ".config", "email", "config.json"));
    const legacy = await run("invite", []);
    expect(legacy.code).toBe(0);
    expect(JSON.parse(legacy.stdout).message).toContain("already sent");
    expect(await events()).toEqual(before);
  });

  test("absent accounts refuse without mentioning the email CLI or opening a mailbox", async () => {
    await writeFile(join(dir, "empty.json"), '{"accounts":{}}');
    for (const command of commands) {
      const result = await run(command, ["--config", join(dir, "empty.json")], { ...requests[command], account: "work" });
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe("There is no work account in the mail config.");
    }
    expect(await events()).toEqual([]);
    expect(await Bun.file(join(dir, "curl.txt")).exists()).toBe(false);
  });
});
