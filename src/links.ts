import type { DeskMailLink } from "./cortex-contract";
import { decode } from "./entities";
import { HOST_LABELS } from "./host";

const MAX_LINKS = 20;
const MAX_ANCHORS = 2000;
const MAX_TAG = 4000;
const MAX_INNER = 8000;
const MAX_TEXT = 200;
const MAX_HREF = 2000;
const CLOSE = /<\/a\s*>/i;
const HREF = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const URL_LIKE = new RegExp(`^(?:https?://)?${HOST_LABELS}\\.?(?::\\d{1,5})?(?:[/?#]\\S*)?$`, "i");
const visible = (html: string): string => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

interface Anchor {
  attrs: string;
  inner: string;
}

function* anchors(html: string): Generator<Anchor> {
  const lower = html.toLowerCase();
  let pos = 0;
  for (let seen = 0; seen < MAX_ANCHORS; seen += 1) {
    const at = lower.indexOf("<a", pos);
    if (at < 0) return;
    const next = lower.charAt(at + 2);
    if (next !== ">" && !/\s/.test(next)) {
      pos = at + 2;
      continue;
    }
    const gt = lower.indexOf(">", at);
    if (gt < 0) return;
    if (gt - at > MAX_TAG) {
      pos = Math.max(at + 2, gt - MAX_TAG);
      continue;
    }
    const window = html.slice(gt + 1, gt + 1 + MAX_INNER);
    const close = CLOSE.exec(window);
    pos = close ? gt + 1 + close.index + close[0].length : gt + 1;
    if (close) yield { attrs: html.slice(at + 2, gt), inner: window.slice(0, close.index) };
  }
}

/**
 * The links of an HTML body whose whole visible text is a host or URL, such as "www.bank.example" or
 * "https://bank.example/login", with their http(s) target: what the Desk needs to see that a link shows one domain and
 * opens another. At most 20. The scan only moves forward and bounds each tag and each anchor's text, so hostile HTML
 * cannot stall it.
 */
export function linksOf(html: string): DeskMailLink[] {
  const out: DeskMailLink[] = [];
  const seen = new Set<string>();
  for (const { attrs, inner } of anchors(html)) {
    const found = HREF.exec(attrs);
    const href = decode((found?.[1] ?? found?.[2] ?? found?.[3] ?? "").trim());
    const text = visible(inner);
    if (!/^https?:\/\//i.test(href) || href.length > MAX_HREF || !URL.canParse(href)) continue;
    if (!text || text.length > MAX_TEXT || !URL_LIKE.test(text)) continue;
    const key = `${text}\n${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
