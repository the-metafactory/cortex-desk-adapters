import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const FLOW = join(ROOT, "flows/desk-mail-triage.yaml");
const request = JSON.stringify({
  mail: { id: "current@example.org", from: { address: "ada@example.org" }, subject: "Agenda", firstParagraph: "Please reply.", receivedAt: "2026-11-06T08:00:00Z", account: "work" },
  meetings: [], vips: [], unimportant: [], corrections: [],
});

async function command(baseUrl: string, args: string[] = [], flow = FLOW) {
  const state = await mkdtemp(join(tmpdir(), "triage-deadline-"));
  try {
    const p = Bun.spawn([process.execPath, join(ROOT, "bin/desk-classify-mail.ts"), "--flow", flow, "--base-url", baseUrl, "--model", "fixture", "--actions-dir", join(ROOT, "test/fixtures/actions"), "--state-dir", state, ...args], {
      stdin: new Blob([request]), stdout: "pipe", stderr: "pipe", env: { ...process.env, DESK_CLASSIFIER_KEY: "fixture" },
    });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code, out, err };
  } finally {
    await rm(state, { recursive: true, force: true });
  }
}

describe("classifier deadline", () => {
  it("rejects an invalid budget before contacting the model", async () => {
    for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "999", "300001", "1e5", ""]) {
      const r = await command("http://127.0.0.1:9/v1", [`--timeout-ms=${value}`]);
      expect(r.code).toBe(2);
      expect(r.out).toBe("");
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toContain("--timeout-ms must be an integer from 1000 to 300000");
    }
  });

  it("keeps the default command working and bounds a configurable multi-round request", async () => {
    let slow = false;
    let missing = false;
    let sawToolError = false;
    let rounds = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(req) {
        const body: unknown = await req.json();
        const hasTool = JSON.stringify(body).includes('"role":"tool"');
        sawToolError ||= JSON.stringify(body).includes("tool error:");
        rounds++;
        if (slow) await Bun.sleep(1200);
        const message = hasTool
          ? { role: "assistant", content: JSON.stringify({ category: "reply", commitment: "none", reason: "Ada asks for a reply.", evidence: missing ? [] : [{ kind: "mail", ref: "<prev@example.org>", title: "Earlier agenda" }] }) }
          : { role: "assistant", content: null, tool_calls: [{ id: "search-1", type: "function", function: { name: missing ? "A_MAIL_READ" : "A_MAIL_SEARCH", arguments: JSON.stringify(missing ? { account: "work", messageId: "<missing@example.org>" } : { account: "work", from: "ada@example.org" }) } }] };
        return Response.json({ id: "fixture", object: "chat.completion", choices: [{ index: 0, message, finish_reason: hasTool ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      },
    });
    try {
      const url = `http://127.0.0.1:${server.port}/v1`;
      const defaultResult = await command(url);
      expect(defaultResult.code).toBe(0);
      expect(JSON.parse(defaultResult.out).category).toBe("reply");
      expect(rounds).toBe(2);
      slow = true;
      const short = await command(url, ["--timeout-ms", "1000"]);
      expect(short.code).not.toBe(0);
      expect(short.out).toBe("");
      const longer = await command(url, ["--timeout-ms", "2000"], join(ROOT, "flows/desk-mail-triage-mini.yaml"));
      expect(longer.code).toBe(0);
      expect(JSON.parse(longer.out)).toMatchObject({ category: "reply", commitment: "none" });
      expect(longer.err).toContain("1 tool calls");
      slow = false;
      missing = true;
      const unavailable = await command(url);
      expect(unavailable.code).toBe(0);
      expect(sawToolError).toBe(true);
      expect(JSON.parse(unavailable.out).evidence).toBeUndefined();
    } finally {
      server.stop(true);
    }
  }, 15000);

  it("ends a command waiting for stdin at the total deadline", async () => {
    const p = Bun.spawn([process.execPath, join(ROOT, "bin/desk-classify-mail.ts"), "--flow", FLOW, "--base-url", "http://127.0.0.1:9/v1", "--model", "fixture", "--timeout-ms", "1000"], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(code).toBe(3);
    expect(out).toBe("");
    expect(err).toBe("desk-classify-mail: no answer within 4 s\n");
    p.stdin.end();
  }, 8000);

  it("changes only the research deadline in the Mini flow profile", async () => {
    const standard = await Bun.file(FLOW).text();
    const mini = await Bun.file(join(ROOT, "flows/desk-mail-triage-mini.yaml")).text();
    expect(mini).toBe(standard.replace("timeout_ms: 60000", "timeout_ms: 110000"));
  });
});
