// Splits a commit message into text, URL and commit-hash segments (pure) for the details pane links.

export type Segment = { kind: 'text' | 'url' | 'hash'; text: string };

const RE = /(https?:\/\/[^\s<>"'`)\]]+[^\s<>"'`)\].,;:!?])|\b([0-9a-f]{7,40})\b/gi;

export function linkify(message: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of message.matchAll(RE)) {
    const at = m.index ?? 0;
    // a hash must contain a digit and a letter, otherwise "1234567" or "deadbeef"-like words in prose would link
    if (m[2] && !(/[0-9]/.test(m[2]) && /[a-f]/i.test(m[2]))) continue;
    if (at > last) out.push({ kind: 'text', text: message.slice(last, at) });
    out.push({ kind: m[1] ? 'url' : 'hash', text: m[0] });
    last = at + m[0].length;
  }
  if (last < message.length) out.push({ kind: 'text', text: message.slice(last) });
  return out;
}
