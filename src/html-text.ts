import { decode } from "./entities";

/** At most this much HTML is read; a mail's first paragraph sits well inside it. */
export const HTML_TEXT_MAX = 1_048_576;

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<[!?][^>]*>?|<(\/?)([a-z][a-z0-9:-]*)([^>]*)>?|[^<]+|</gi;
const RAW = new Set(["script", "style", "title", "textarea", "template", "noscript", "svg", "math", "xml"]);
const SKIPPED = new Set(["head"]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "center", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const HIDDEN_STYLE = /(?:^|[;\s"'])(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all|opacity\s*:\s*0(?:\.0*)?\s*(?:[;!"']|$))/i;
const HIDDEN_ATTR = /(?:^|\s)hidden(?:\s|=|\/|$)/i;

const PARAGRAPH = "\n\n";

function hidden(attrs: string): boolean {
  if (HIDDEN_ATTR.test(attrs.replace(/"[^"]*"|'[^']*'/g, ""))) return true;
  const style = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return style !== null && HIDDEN_STYLE.test(style[1] ?? style[2] ?? "");
}

/**
 * The visible text of an HTML body, as a reader sees it: scripts, styles, the head, comments and hidden elements
 * (`hidden`, `display:none`, `visibility:hidden`, `mso-hide:all`, `opacity:0`) dropped, block elements as blank lines,
 * `<br>` as a line break, entities decoded, other whitespace collapsed. It does not build a tree: it scans the tags once,
 * forward only, so hostile HTML cannot stall it. Input beyond HTML_TEXT_MAX is ignored.
 */
export function htmlText(html: string): string {
  const source = html.slice(0, HTML_TEXT_MAX);
  const lower = source.toLowerCase();
  const out: string[] = [];
  let skip: { name: string; depth: number } | undefined;
  TOKEN.lastIndex = 0;
  for (let token = TOKEN.exec(source); token; token = TOKEN.exec(source)) {
    const [whole, close, rawName, attrs = ""] = token;
    if (rawName === undefined) {
      if (skip || whole.startsWith("<!") || whole.startsWith("<?")) continue;
      out.push(decode(whole).replace(/\s+/g, " "));
      continue;
    }
    const name = rawName.toLowerCase();
    const opening = close !== "/";
    const selfClosing = VOID.has(name) || /\/\s*$/.test(attrs);
    if (skip) {
      if (skip.name === "head" && name === "body") skip = undefined;
      else if (name === skip.name && !selfClosing) skip.depth += opening ? 1 : -1;
      if (skip?.depth === 0) skip = undefined;
      continue;
    }
    if (opening && RAW.has(name) && !selfClosing) {
      const end = lower.indexOf(`</${name}`, TOKEN.lastIndex);
      if (end < 0) break;
      const gt = lower.indexOf(">", end);
      TOKEN.lastIndex = gt < 0 ? source.length : gt + 1;
      continue;
    }
    if (opening && !selfClosing && (SKIPPED.has(name) || hidden(attrs))) {
      skip = { name, depth: 1 };
      continue;
    }
    if (name === "br") out.push("\n");
    else if (BLOCK.has(name)) out.push(PARAGRAPH);
  }
  return out.join("");
}
