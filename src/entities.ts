const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const codePoint = (n: number): string => (Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ");

/** Decodes numeric character references and the common named entities; an unknown name stays as written. */
export function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{2,8});/gi, (whole, name: string) => {
    if (/^#x/i.test(name)) return codePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return codePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}
