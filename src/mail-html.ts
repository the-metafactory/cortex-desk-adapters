export const HTML_MAX = 2_000_000;

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const CONTAINERS = "h[1-6]|p|strong|em|del|code|pre|blockquote|ul|ol|li|table|thead|tbody|tr|th|td";
const TAG = new RegExp(`<(?:/(?:${CONTAINERS}|a)|(?:${CONTAINERS}|br|hr)|ol start="\\d{1,9}"|t[hd] align="(?:left|center|right)"|a href="([^"<>]*)")>`, "y");

function isWebLink(attribute: string): boolean {
  if (/&(?!amp;)/.test(attribute)) return false;
  const href = attribute.replace(/&amp;/g, "&");
  if (!/^https?:\/\/\S+$/i.test(href)) return false;
  return URL.canParse(href);
}

/**
 * True only for HTML built from a closed set of formatting elements, whose only attributes are an http or https `href` and
 * table alignment. The field may come from any earlier step of a routine, a model's included, so this refuses by default:
 * any other `<` fails, which covers scripts, images, styles, frames, forms, comments and event handlers. It does not parse
 * HTML; it holds the text to the shape a formatter that escapes its text emits. Inert means no active or remote content: it
 * does not compare the html to the text part or judge where an http link leads.
 */
export function mailHtmlIsInert(html: string): boolean {
  if (CONTROL.test(html)) return false;
  for (let at = html.indexOf("<"); at !== -1; at = html.indexOf("<", at + 1)) {
    TAG.lastIndex = at;
    const tag = TAG.exec(html);
    if (!tag) return false;
    if (tag[1] !== undefined && !isWebLink(tag[1])) return false;
  }
  return true;
}
