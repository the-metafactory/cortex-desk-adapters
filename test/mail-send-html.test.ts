import { describe, expect, it } from "bun:test";
import { readMailSendRequest, sendOwnMail, type MailSendDeps } from "../src/mail-send";
import type { SmtpAccount } from "../src/smtp";

const OWN = "me@example.org";
const STRANGER = "stranger@example.com";
const ACCOUNT: SmtpAccount = { name: "personal", host: "smtp.example.org", port: 587, secure: false, user: OWN, pass: "pw", from: OWN };
const DIGEST = "50 Artikel vom 2026-11-06 (Europe/Zurich).\n\n### Sicherheit\n- **Patchday**: Microsoft schliesst Lücken.\n";
const HTML = '<p>50 Artikel vom 2026-11-06 (Europe/Zurich).</p>\n<h3>Sicherheit</h3>\n<ul>\n<li><strong>Patchday</strong>: Microsoft schliesst Lücken. <a href="https://example.org/a?b=1&amp;c=2">Quelle</a></li>\n</ul>\n';

async function send(fields: Record<string, unknown>) {
  const sends: { rcpt: string; message: string }[] = [];
  const deps: MailSendDeps = {
    defaultAccount: async () => "personal",
    ownAddresses: async () => [OWN],
    smtp: async () => ACCOUNT,
    send: async (_account, rcpt, message) => void sends.push({ rcpt, message }),
    now: () => Date.UTC(2026, 10, 7, 7, 0),
    newId: () => "id1",
  };
  const attempt = async () => sendOwnMail(readMailSendRequest(JSON.stringify({ subject: "heise.de", body: DIGEST, ...fields })), deps);
  const outcome = await attempt().then(
    () => null,
    (error: Error) => error.message,
  );
  return { sends, outcome };
}

interface Part {
  headers: string[];
  text: string;
}

function partsOf(message: string): { headers: string[]; boundary: string; parts: Part[]; lines: string[] } {
  const split = message.indexOf("\r\n\r\n");
  const headers = message.slice(0, split).split("\r\n");
  const boundary = /^Content-Type: multipart\/alternative; boundary="([^"]+)"$/m.exec(message.slice(0, split))?.[1];
  if (!boundary) throw new Error("not multipart/alternative");
  const lines = message.slice(split + 4).split("\r\n");
  const opening = lines.flatMap((line, index) => (line === `--${boundary}` ? [index] : []));
  const closing = lines.indexOf(`--${boundary}--`);
  const parts = opening.map((start, index) => {
    const blank = lines.indexOf("", start);
    const end = opening[index + 1] ?? closing;
    return { headers: lines.slice(start + 1, blank), text: Buffer.from(lines.slice(blank + 1, end).join(""), "base64").toString("utf8") };
  });
  return { headers, boundary, parts, lines };
}

describe("a mail with an html part", () => {
  it("carries the body unchanged as the first part and the html as the preferred last part", async () => {
    const { sends, outcome } = await send({ html: HTML });
    expect(outcome).toBeNull();
    const { parts } = partsOf(sends[0]!.message);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.headers).toEqual(["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64"]);
    expect(parts[0]!.text).toBe(DIGEST);
    expect(parts[1]!.headers).toEqual(["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"]);
    expect(parts[1]!.text).toBe(HTML);
  });

  it("keeps a boundary that nothing in the content can end early, even content quoting the boundary", async () => {
    const first = partsOf((await send({ html: HTML })).sends[0]!.message);
    const quoted = `--${first.boundary}\r\nContent-Type: text/html\r\n\r\n--${first.boundary}--`;
    const { sends } = await send({ body: quoted, html: `<p>${quoted.replace(/\r\n/g, " ")}</p>` });
    const { boundary, parts, lines } = partsOf(sends[0]!.message);
    expect(boundary).toBe(first.boundary);
    expect(boundary.length).toBeLessThanOrEqual(70);
    expect(lines.filter((line) => line.startsWith(`--${boundary}`))).toEqual([`--${boundary}`, `--${boundary}`, `--${boundary}--`]);
    expect(parts[0]!.text).toBe(quoted);
  });

  it("adds no header from the html", async () => {
    const { sends } = await send({ html: `<p>x</p>\r\nBcc: ${STRANGER}\r\n` });
    const { headers } = partsOf(sends[0]!.message);
    expect(headers.filter((h) => /^(cc|bcc|reply-to):/i.test(h))).toEqual([]);
    expect(sends.map((s) => s.rcpt)).toEqual([OWN]);
  });

  it("stays under the recipient limit: a stranger is refused even with a clean html part", async () => {
    const { sends, outcome } = await send({ html: HTML, to: STRANGER });
    expect(outcome).toContain("nothing was sent");
    expect(sends).toEqual([]);
  });
});

describe("a mail without an html part", () => {
  it("is the same single text part as before", async () => {
    const { sends } = await send({});
    const message = sends[0]!.message;
    expect(message).toContain("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    expect(message).not.toContain("multipart");
    expect(Buffer.from(message.slice(message.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, ""), "base64").toString("utf8")).toBe(DIGEST);
  });
});

describe("an html field the send side does not trust", () => {
  const refused: [string, unknown][] = [
    ["a script", "<p>x</p><script>alert(1)</script>"],
    ["a script in capitals", "<SCRIPT>alert(1)</SCRIPT>"],
    ["a remote image", '<img src="https://tracker.example/x.png">'],
    ["an event handler", '<p onclick="alert(1)">x</p>'],
    ["a style sheet", "<style>body{background:url(https://tracker.example/x)}</style>"],
    ["an inline style", '<p style="background:url(https://tracker.example/x)">x</p>'],
    ["an iframe", '<iframe src="https://example.org"></iframe>'],
    ["a form", '<form action="https://example.org"><input name="a"></form>'],
    ["a comment", "<!-- <script>alert(1)</script> -->"],
    ["an unclosed tag", "<p>x</p><img src=x onerror=alert(1) "],
    ["a stray angle bracket", "a < b"],
    ["a javascript link", '<a href="javascript:alert(1)">x</a>'],
    ["a data link", '<a href="data:text/html,x">x</a>'],
    ["a mailto link", `<a href="mailto:${STRANGER}">x</a>`],
    ["a relative link", '<a href="/x">x</a>'],
    ["an entity hiding a scheme", '<a href="java&#115;cript:alert(1)">x</a>'],
    ["an entity hiding http", '<a href="&#104;ttp://example.org">x</a>'],
    ["a tab hiding a scheme", '<a href="java\tscript:alert(1)">x</a>'],
    ["a leading space before http", '<a href=" https://example.org">x</a>'],
    ["a link with a second attribute", '<a href="https://example.org" onclick="alert(1)">x</a>'],
    ["a single-quoted link", "<a href='javascript:alert(1)'>x</a>"],
    ["a control character", "<p>x\u0000</p>"],
    ["an empty value", ""],
    ["a value that is not text", { html: "<p>x</p>" }],
  ];
  for (const [name, html] of refused) {
    it(`refuses ${name} with no send`, async () => {
      const { sends, outcome } = await send({ html });
      expect(outcome).toContain("nothing was sent");
      expect(sends).toEqual([]);
    });
  }

  const accepted: [string, string][] = [
    ["every element the formatter emits", '<h1>a</h1><h6>b</h6><p>c<br>d</p><hr><em>e</em><del>f</del><code>g</code><pre><code>h</code></pre><blockquote><p>i</p></blockquote><ol start="3"><li>j</li></ol>'],
    ["a table with alignment", '<table><thead><tr><th align="left">a</th></tr></thead><tbody><tr><td align="right">b</td></tr></tbody></table>'],
    ["an escaped script as text", "<p>&lt;script&gt;alert(1)&lt;/script&gt; a &gt; b</p>"],
    ["an http link", '<a href="http://example.org/a">x</a>'],
    [
      "output captured from A_FORMAT_MARKDOWN",
      "<p>50 Artikel vom 2026-11-06 (Europe/Zurich).<br>Hinweis.</p>\n<h3>Sicherheit</h3>\n<ul>\n<li><strong>Patchday:</strong> A &amp; B &lt;script&gt;x&lt;/script&gt; &quot;d&quot; &#39;e&#39; <a href=\"https://example.org/a%27b?x=1&amp;y=2\">Quelle</a></li>\n</ul>\n<ol>\n<li>eins</li>\n</ol>\n<blockquote>\n<p>Zitat</p>\n</blockquote>\n<hr>\n<p><code>code</code> <del>alt</del> <em>neu</em></p>\n<pre><code>&lt;y&gt;</code></pre>\n<table>\n<thead>\n<tr>\n<th align=\"left\">a</th>\n</tr>\n</thead>\n<tbody><tr>\n<td align=\"left\">b</td>\n</tr>\n</tbody></table>\n<ol start=\"3\">\n<li>drei</li>\n</ol>\n",
    ],
  ];
  for (const [name, html] of accepted) {
    it(`accepts ${name}`, async () => {
      const { sends, outcome } = await send({ html });
      expect(outcome).toBeNull();
      expect(sends).toHaveLength(1);
    });
  }
});
