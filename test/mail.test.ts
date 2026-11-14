import { expect, it } from "bun:test";
import { appleMailUrl, firstParagraph, firstParagraphOfHtml, parseFrom, readFirstParagraph, toDeskMail } from "../src/mail";
import { htmlText } from "../src/html-text";

it("parses a display name and address, lower-casing the address", () => {
  expect(parseFrom("Ada Lovelace <Ada@Example.org>")).toEqual({ name: "Ada Lovelace", address: "ada@example.org" });
  expect(parseFrom('"Finance & Controlling" <fc@example.ch>')).toEqual({ name: "Finance & Controlling", address: "fc@example.ch" });
  expect(parseFrom("bare@example.ch")).toEqual({ address: "bare@example.ch" });
});

it("builds an Apple Mail link from the Message-ID", () => {
  expect(appleMailUrl("<abc.123@mail.example>")).toBe("message://%3Cabc.123%40mail.example%3E");
  expect(appleMailUrl("abc.123@mail.example")).toBe("message://%3Cabc.123%40mail.example%3E");
});

it("takes the first paragraph after the headers, skipping a greeting", () => {
  const out = ["━━━━", "Subject: Agenda", "From: x <x@y>", "━━━━", "", "Hi Ada,", "", "Could you confirm the agenda", "for Monday?", "", "Thanks"].join("\n");
  expect(firstParagraph(out)).toBe("Could you confirm the agenda for Monday?");
});

it("caps a long paragraph at 400 characters", () => {
  const out = `━━\nh\n━━\n\n${"word ".repeat(200)}`;
  expect(firstParagraph(out)?.length).toBe(398);
});

it("maps a listed message to a Desk mail item", () => {
  const item = toDeskMail({ uid: 1, messageId: "<m1@x>", from: "A <a@x.ch>", subject: "", date: "2026-10-30T14:28:39.000Z", flags: [] }, "work", "Body");
  expect(item).toEqual({ kind: "mail", id: "m1@x", from: { name: "A", address: "a@x.ch" }, subject: "(no subject)", receivedAt: "2026-10-30T14:28:39.000Z", unread: true, firstParagraph: "Body", url: "message://%3Cm1%40x%3E", account: "work" });
});

const SEP = "━".repeat(60);
const getOutput = (body: string): string => ["", SEP, "Subject: Invoice", "From: x <x@y>", "UID: 7", "Flags: ", SEP, body, SEP, ""].join("\n");

/** A fake `email` CLI: the plain-text and HTML output of one message, and every call it received. */
function fakeEmail(plain: string, html: string): { run: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: async (args) => (calls.push(args), args.includes("--html") ? getOutput(html) : getOutput(plain)) };
}

it("reads a plain-text mail without fetching its HTML", async () => {
  const email = fakeEmail("Hi Ada,\n\nThe invoice is attached.\n\nBest", "<p>unused</p>");
  expect(await readFirstParagraph(email.run, "work", 7)).toBe("The invoice is attached.");
  expect(email.calls).toEqual([["get", "-a", "work", "-u", "7"]]);
});

it("reads an HTML-only mail from its HTML body, never marking it read", async () => {
  const html = `<html><head><title>Invoice</title><style>p { color: red }</style></head><body>
    <div style="display:none">Preheader text</div><p>Guten Tag Herr Fischer,</p>
    <p>Your invoice of&nbsp;CHF&nbsp;120.00 is due on 30 November &amp; can be paid<br>by card.</p><p>Thanks</p></body></html>`;
  const email = fakeEmail("(no body)", html);
  expect(await readFirstParagraph(email.run, "work", 7)).toBe("Your invoice of CHF 120.00 is due on 30 November & can be paid by card.");
  expect(email.calls).toEqual([["get", "-a", "work", "-u", "7"], ["get", "--html", "-a", "work", "-u", "7"]]);
  expect(email.calls.flat()).not.toContain("--mark-read");
});

it("prefers the plain-text part of a multipart mail", async () => {
  const email = fakeEmail("Plain text paragraph.", "<p>HTML paragraph.</p>");
  expect(await readFirstParagraph(email.run, "work", 7)).toBe("Plain text paragraph.");
  expect(email.calls).toHaveLength(1);
});

it("gives no paragraph for an HTML mail with no visible text", async () => {
  const html = `<html><head><style>.x{}</style></head><body><script>var a = "text";</script><!-- comment -->
    <img src="https://x.example/p.png" alt="logo"><span hidden>secret</span><table><tr><td>&nbsp;</td></tr></table></body></html>`;
  expect(await readFirstParagraph(fakeEmail("(no body)", html).run, "work", 7)).toBeUndefined();
});

it("never passes the CLI's placeholder on as a paragraph", async () => {
  expect(firstParagraph(getOutput("(no body)"))).toBeUndefined();
  expect(firstParagraphOfHtml(getOutput("(no body)"))).toBeUndefined();
  expect(await readFirstParagraph(fakeEmail("(no body)", "(no body)").run, "work", 7)).toBeUndefined();
  const listed = { uid: 1, messageId: "<m1@x>", from: "a@x.ch", subject: "s", date: "2026-10-30T14:28:39.000Z", flags: [] };
  expect(toDeskMail(listed, "work", "(no body)")).not.toHaveProperty("firstParagraph");
});

it("caps an HTML paragraph at 400 characters", async () => {
  const paragraph = await readFirstParagraph(fakeEmail("(no body)", `<p>${"word ".repeat(200)}</p>`).run, "work", 7);
  expect(paragraph?.length).toBe(398);
});

it("turns HTML into the text a reader sees", () => {
  expect(htmlText("<div>One<div>Two</div></div><p>Three<br>four</p>").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)).toEqual(["One", "Two", "Three\nfour"]);
  expect(htmlText('<div style="mso-hide:all"><div>nested</div>gone</div>shown')).toBe("shown");
  expect(htmlText('<span style="opacity: 0.5">half</span><span style="opacity:0">none</span>')).toBe("half");
  expect(htmlText("<head><title>t</title><body>no closing head")).toBe("no closing head");
  expect(htmlText("&#x41;&#66;&lt;&unknown; a < b")).toBe("AB<&unknown; a < b");
  expect(htmlText("<script>never closed")).toBe("");
});

it("does not read the word hidden inside an attribute value as the hidden attribute", () => {
  expect(htmlText('<a title="no hidden fees" class="x hidden y">Pay now</a>')).toBe("Pay now");
});

it("scans hostile HTML in linear time", () => {
  const hostile = [
    "<div>".repeat(200_000),
    '<p style="display:none">'.repeat(100_000),
    `<span hidden>${"<span>".repeat(100_000)}`,
    "<style>x</style>".repeat(100_000),
    "<!--x-->".repeat(100_000),
    "&#x41;&amp;".repeat(100_000),
    "<div ".repeat(100_000),
  ];
  for (const html of hostile) {
    const started = performance.now();
    htmlText(html);
    expect(performance.now() - started).toBeLessThan(1000);
  }
});
