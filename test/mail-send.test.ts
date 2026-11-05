import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMailSendRequest, sendOwnMail, type MailSendDeps } from "../src/mail-send";
import { ownAddresses, type SmtpAccount } from "../src/smtp";

const OWN = "me@example.org";
const OTHER_OWN = "me@work.example.net";
const STRANGER = "stranger@example.com";
const ACCOUNT: SmtpAccount = { name: "personal", host: "smtp.example.org", port: 587, secure: false, user: OWN, pass: "pw", from: OWN, fromName: "Example Principal" };
const REQ = { subject: "Daily summary", body: "Three articles.\n\nBcc: stranger@example.com\n" };

function fakeDeps(over: Partial<MailSendDeps> = {}) {
  const sends: { rcpt: string; message: string }[] = [];
  const deps: MailSendDeps = {
    defaultAccount: async () => "personal",
    ownAddresses: async () => [OWN, OTHER_OWN],
    smtp: async () => ACCOUNT,
    send: async (_account, rcpt, message) => {
      sends.push({ rcpt, message });
    },
    now: () => Date.UTC(2026, 10, 6, 7, 0),
    newId: () => "id1",
    ...over,
  };
  return { deps, sends };
}

const attempt = (fields: Record<string, unknown>, over: Partial<MailSendDeps> = {}) => {
  const f = fakeDeps(over);
  return { sends: f.sends, result: (async () => sendOwnMail(readMailSendRequest(JSON.stringify({ ...REQ, ...fields })), f.deps))() };
};

const headersOf = (message: string): string[] => message.slice(0, message.indexOf("\r\n\r\n")).split("\r\n");
const bodyOf = (message: string): string => Buffer.from(message.slice(message.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8");

describe("a permitted recipient", () => {
  it("sends once to the config's own entry, whichever case the request uses", async () => {
    const { sends, result } = attempt({ to: "ME@work.example.net" });
    expect(await result).toEqual({ id: "id1@example.org", message: `The mail went to ${OTHER_OWN}.` });
    expect(sends.map((s) => s.rcpt)).toEqual([OTHER_OWN]);
    expect(headersOf(sends[0]!.message)).toContain(`To: ${OTHER_OWN}`);
  });

  it("sends to the config's entry when a look-alike character lowercases onto it", async () => {
    const { sends, result } = attempt({ to: "me@wor\u212A.example.net" });
    await result;
    expect(sends.map((s) => s.rcpt)).toEqual([OTHER_OWN]);
    expect(sends[0]!.message).not.toContain("\u212A");
  });

  it("folds a long non-ASCII subject into encoded words within the RFC 2047 limit", async () => {
    const subject = "Ü".repeat(150) + "😀".repeat(30);
    const { sends, result } = attempt({ subject });
    await result;
    const message = sends[0]!.message;
    const lines = message.slice(message.indexOf("Subject: ") + "Subject: ".length, message.indexOf("\r\nDate:")).split("\r\n ");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(75);
    const bytes = lines.flatMap((line) => [...Buffer.from(line.slice("=?UTF-8?B?".length, -"?=".length), "base64")]);
    expect(Buffer.from(bytes).toString("utf8")).toBe(subject);
  });

  it("sends to the account's own address when the request names no recipient", async () => {
    const { sends, result } = attempt({});
    await result;
    expect(sends.map((s) => s.rcpt)).toEqual([OWN]);
    expect(headersOf(sends[0]!.message)).toContain(`To: ${OWN}`);
  });

  it("uses the named account's server and the default account otherwise", async () => {
    const names: string[] = [];
    const smtp = async (name: string) => {
      names.push(name);
      return ACCOUNT;
    };
    await attempt({ account: "work" }, { smtp }).result;
    await attempt({}, { smtp }).result;
    expect(names).toEqual(["work", "personal"]);
  });

  it("builds one text mail whose body cannot add a header", async () => {
    const { sends, result } = attempt({ subject: "Zusammenfassung für heute" });
    await result;
    const message = sends[0]!.message;
    const headers = headersOf(message);
    expect(headers).toContain('From: "Example Principal" <me@example.org>');
    expect(headers).toContain("Subject: =?UTF-8?B?WnVzYW1tZW5mYXNzdW5nIGbDvHIgaGV1dGU=?=");
    expect(headers).toContain("Auto-Submitted: auto-generated");
    expect(headers.filter((h) => /^(cc|bcc|reply-to):/i.test(h))).toEqual([]);
    expect(bodyOf(message)).toBe(REQ.body);
  });
});

describe("a disallowed recipient refuses without calling the transport", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["a stranger", { to: STRANGER }],
    ["a lookalike domain", { to: "me@example.org.evil.example" }],
    ["a subaddress of an own address", { to: "me+x@example.org" }],
    ["a display name around an own address", { to: `Me <${OWN}>` }],
    ["a comma list", { to: `${OWN},${STRANGER}` }],
    ["a semicolon list", { to: `${OWN};${STRANGER}` }],
    ["a list as an array", { to: [OWN, STRANGER] }],
    ["an empty recipient", { to: "" }],
    ["a cc to a stranger", { cc: STRANGER }],
    ["a cc to an own address", { cc: OWN }],
    ["a bcc to a stranger", { bcc: STRANGER }],
    ["a bcc in another case", { BCC: [STRANGER] }],
    ["a Reply-To field", { replyTo: STRANGER }],
    ["a header field", { headers: { Bcc: STRANGER } }],
    ["a From field", { from: STRANGER }],
  ];
  for (const [name, fields] of cases) {
    it(name, async () => {
      const { sends, result } = attempt(fields);
      await expect(result).rejects.toThrow("nothing was sent");
      expect(sends).toEqual([]);
    });
  }

  it("an empty own list", async () => {
    const { sends, result } = attempt({}, { ownAddresses: async () => [] });
    await expect(result).rejects.toThrow("nothing was sent");
    expect(sends).toEqual([]);
  });
});

describe("header injection refuses without calling the transport", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["CRLF in the subject", { subject: `Hello\r\nBcc: ${STRANGER}` }],
    ["LF in the subject", { subject: `Hello\nBcc: ${STRANGER}` }],
    ["a bare CR in the subject", { subject: `Hello\rBcc: ${STRANGER}` }],
    ["a Unicode line separator in the subject", { subject: `Hello\u2028Bcc: ${STRANGER}` }],
    ["CRLF after an own address", { to: `${OWN}\r\nBcc: ${STRANGER}` }],
    ["a trailing line break on an own address", { to: `${OWN}\n` }],
    ["a line break in the account", { account: `personal\r\nBcc: ${STRANGER}` }],
  ];
  for (const [name, fields] of cases) {
    it(name, async () => {
      const { sends, result } = attempt(fields);
      await expect(result).rejects.toThrow();
      expect(sends).toEqual([]);
    });
  }
});

it("refuses an empty subject or body, and a request that is not JSON", () => {
  expect(() => readMailSendRequest(JSON.stringify({ ...REQ, subject: " " }))).toThrow("subject");
  expect(() => readMailSendRequest(JSON.stringify({ ...REQ, body: "" }))).toThrow("body");
  expect(() => readMailSendRequest("nope")).toThrow("not valid JSON");
});

describe("with the real config and the real command", () => {
  let dir: string;
  const logFile = () => join(dir, "curl.log");

  const script = (log: string) => `#!/bin/sh
echo "$@" >> "${log}"
cat >> "${log}"
exit 0
`;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mail-send-test-"));
    await mkdir(join(dir, ".config", "email"), { recursive: true });
    const account = (email: string, user: string) => ({
      from: { name: "Example Principal", email },
      smtp: { host: "smtp.example.org", port: 587, secure: false, auth: { user, pass: "keychain:example-service" } },
      imap: { enabled: true, host: "imap.example.org", port: 993, tls: true, auth: { user: `imap-${email}`, pass: "keychain:example-service" } },
    });
    await writeFile(join(dir, ".config", "email", "config.json"), JSON.stringify({ defaultAccount: "personal", accounts: { personal: account(OWN, OWN), work: account(OTHER_OWN, "login-without-domain") } }));
    await mkdir(join(dir, "fake-bin"));
    await writeFile(join(dir, "fake-bin", "curl"), script(logFile()));
    await writeFile(join(dir, "fake-bin", "security"), "#!/bin/sh\necho example-password\n");
    await chmod(join(dir, "fake-bin", "curl"), 0o755);
    await chmod(join(dir, "fake-bin", "security"), 0o755);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const runCommand = async (args: string[], stdin = "") => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "bin", "desk-mail-send.ts"), ...args], {
      env: { HOME: dir, PATH: `${join(dir, "fake-bin")}:/usr/bin:/bin` },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  };
  const curlRan = () => stat(logFile()).then(() => true, () => false);

  it("reads every account's From address, and no login name, even one shaped like an address", async () => {
    expect((await ownAddresses(join(dir, ".config", "email", "config.json"))).sort()).toEqual([OWN, OTHER_OWN].sort());
  });

  it("refuses a login name that is shaped like an address, without starting curl", async () => {
    const { code } = await runCommand([], JSON.stringify({ ...REQ, to: `imap-${OWN}` }));
    expect(code).toBe(1);
    expect(await curlRan()).toBe(false);
  });

  it("refuses when the config cannot be read", async () => {
    await expect(ownAddresses(join(dir, "missing.json"))).rejects.toThrow("could not be read");
  });

  it("submits a permitted mail through curl once, from a request file, and never puts the password in argv", async () => {
    const requestFile = join(dir, "request.json");
    await writeFile(requestFile, JSON.stringify({ ...REQ, to: OTHER_OWN }));
    const { code, stdout } = await runCommand(["--request-file", requestFile]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).message).toBe(`The mail went to ${OTHER_OWN}.`);
    const log = await readFile(logFile(), "utf8");
    expect(log).toContain(`mail-rcpt = "${OTHER_OWN}"`);
    expect(log).toContain(`mail-from = "${OWN}"`);
    expect(log.split("\n").filter((line) => line.includes("--upload-file")).join("\n")).not.toContain("example-password");
    expect(log.split("mail-rcpt").length - 1).toBe(1);
  });

  it("refuses a stranger read from stdin without starting curl", async () => {
    const { code, stderr } = await runCommand([], JSON.stringify({ ...REQ, to: STRANGER }));
    expect(code).toBe(1);
    expect(stderr).toContain("not one of the principal's own configured addresses");
    expect(await curlRan()).toBe(false);
  });

  it("refuses a bcc without starting curl", async () => {
    const { code } = await runCommand([], JSON.stringify({ ...REQ, bcc: STRANGER }));
    expect(code).toBe(1);
    expect(await curlRan()).toBe(false);
  });
});
