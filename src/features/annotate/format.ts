// Annotation column text and colors (pure; tested in format.test.ts). Name shortening is a port of IntelliJ's
// ShortNameType, colors follow its "Order" (by commit age) and "Author" color modes.
import { isUncommitted, type BlameCommit, type BlameLine } from './blame';

export type NameType = 'initials' | 'lastName' | 'firstName' | 'fullName' | 'email';
export type ColorMode = 'order' | 'author' | 'hide';

export interface ColumnOptions {
  showHash: boolean;
  showDate: boolean;
  showAuthor: boolean;
  showSubject: boolean;
  names: NameType;
  /** use the committer date instead of the author date */
  commitDate: boolean;
  locale?: string;
  /** cap for the author / subject parts (characters) */
  maxAuthor?: number;
  maxSubject?: number;
}

const DELIMITERS = /[.,<>()":_-]/g;

/** IntelliJ ShortNameType.shorten(). `input` is a name, optionally with "<email>". */
export function shortenName(input: string, type: NameType): string {
  const raw = input.replace(/\s+/g, ' ').trim();
  let name = raw;
  let fromEmail = false;
  const es = name.indexOf('<');
  const ee = name.indexOf('>');
  const at = name.indexOf('@');
  if (es >= 0 && es < at && at < ee) {
    const email = name.slice(es + 1, ee).trim();
    if (type === 'email') return email;
    const prefix = name.slice(0, es).trim();
    const suffix = name.slice(ee + 1).trim();
    if (prefix && suffix) name = `${prefix} ${suffix}`;
    else if (prefix) name = prefix;
    else if (suffix) name = suffix;
    else {
      fromEmail = true;
      name = email;
    }
  }
  if (type === 'fullName') return name;
  if (type === 'email') {
    const i = name.indexOf('@');
    if (i < 0) return name;
    let s = name.lastIndexOf(' ', i);
    if (s < 0) s = 0;
    let e = name.indexOf(' ', i);
    if (e < 0) e = name.length;
    return name.slice(s, e).trim();
  }
  const ai = name.indexOf('@');
  if (ai > 0 && !name.includes(' ')) {
    fromEmail = true;
    name = name.slice(0, ai).replace(DELIMITERS, ' ');
  }
  const parts = name.split(' ').filter((p) => p.trim());
  if (!parts.length) return raw;
  if (type === 'initials') {
    return parts
      .flatMap((p) => p.split(DELIMITERS))
      .filter((p) => p.trim())
      .map((p) => p[0].toUpperCase())
      .join('');
  }
  let r = type === 'firstName' ? parts[0] : parts[parts.length - 1];
  if (fromEmail && r && r[0] !== r[0].toUpperCase()) r = r[0].toUpperCase() + r.slice(1);
  return r;
}

/** The author as IntelliJ's VcsUserUtil.toExactString: "Name <email>". */
export function exactUser(name: string, mail: string): string {
  return mail ? `${name} <${mail}>` : name;
}

export function commitTime(c: BlameCommit, commitDate: boolean): number {
  return commitDate ? c.committerTime : c.authorTime;
}

/** Short date (annotation column), like IntelliJ's DateFormatUtil.formatDate. */
export function formatShortDate(unixSeconds: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(new Date(unixSeconds * 1000));
}

/** Date and time (tooltip), like DateFormatUtil.formatDateTime. */
export function formatDateTime(unixSeconds: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(unixSeconds * 1000));
}

function clip(s: string, max: number | undefined): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + '…';
}

/** Column parts of one commit, in IntelliJ's aspect order: revision, date, author (+ subject). */
export function columnParts(c: BlameCommit, o: ColumnOptions): string[] {
  const parts: string[] = [];
  if (o.showHash) parts.push(c.hash.slice(0, 8));
  if (o.showDate) parts.push(formatShortDate(commitTime(c, o.commitDate), o.locale));
  if (o.showAuthor) parts.push(clip(shortenName(exactUser(c.author, c.authorMail), o.names), o.maxAuthor ?? 20));
  if (o.showSubject) parts.push(clip(c.summary, o.maxSubject ?? 40));
  return parts;
}

/**
 * Text of every line, each column left-aligned to the widest value so the gutter forms a table.
 * Uncommitted lines are blank. `width` is the total width in characters.
 */
export function buildColumns(lines: BlameLine[], commits: Map<string, BlameCommit>, o: ColumnOptions): { texts: string[]; width: number } {
  const per = new Map<string, string[]>();
  for (const c of commits.values()) if (!isUncommitted(c.hash)) per.set(c.hash, columnParts(c, o));
  const widths: number[] = [];
  for (const p of per.values()) p.forEach((v, i) => (widths[i] = Math.max(widths[i] ?? 0, [...v].length)));
  const width = widths.reduce((a, b) => a + b, 0) + Math.max(0, widths.length - 1);
  const texts = lines.map((l) => {
    const p = per.get(l.hash);
    if (!p) return '';
    return p.map((v, i) => (i === p.length - 1 ? v : v + ' '.repeat(widths[i] - [...v].length))).join(' ');
  });
  return { texts, width };
}

/** Number of "age" color steps (IntelliJ uses a gradient between two anchor colors). */
export const ORDER_STEPS = 10;

/**
 * Color step (0 = most recent … ORDER_STEPS-1 = oldest) for every commit, ranking distinct commits by time like
 * IntelliJ's "Order" mode so that even a file with dates far apart gets the full gradient.
 */
export function orderSteps(commits: Map<string, BlameCommit>, commitDate: boolean): Map<string, number> {
  const list = [...commits.values()].filter((c) => !isUncommitted(c.hash)).sort((a, b) => commitTime(b, commitDate) - commitTime(a, commitDate));
  const out = new Map<string, number>();
  const n = list.length;
  list.forEach((c, i) => out.set(c.hash, n <= 1 ? 0 : Math.round((i / (n - 1)) * (ORDER_STEPS - 1))));
  return out;
}

/** Stable small hash of a string (author colors). */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Background of an annotation step. Recent commits are more saturated; `dark` picks a palette that reads on dark
 * editor backgrounds. Returns a CSS rgba() string.
 */
export function orderColor(step: number, dark: boolean): string {
  const t = Math.min(1, Math.max(0, step / (ORDER_STEPS - 1)));
  // IntelliJ anchors: recent = warm/strong, old = faint. Hue drifts from amber-green to blue-grey.
  const [r1, g1, b1] = dark ? [70, 110, 70] : [190, 230, 180];
  const [r2, g2, b2] = dark ? [60, 63, 75] : [235, 238, 245];
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  const alpha = dark ? 0.85 - t * 0.55 : 0.9 - t * 0.6;
  return `rgba(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)}, ${alpha.toFixed(2)})`;
}

/** Distinct pastel per author (by email). */
export function authorColor(key: string, dark: boolean): string {
  const hue = hashString(key) % 360;
  return dark ? `hsla(${hue}, 35%, 35%, 0.55)` : `hsla(${hue}, 60%, 85%, 0.9)`;
}

/** 0-based line indexes where a new group of consecutive lines of the same commit starts. */
export function groupStarts(lines: BlameLine[]): boolean[] {
  return lines.map((l, i) => i === 0 || lines[i - 1].hash !== l.hash);
}
