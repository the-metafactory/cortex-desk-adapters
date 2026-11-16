/** Apple Mail opens a message from its Message-ID: message://%3Cid%3E. */
export function appleMailUrl(messageId: string): string {
  return `message://${encodeURIComponent(`<${messageId.replace(/^<|>$/g, "")}>`)}`;
}
