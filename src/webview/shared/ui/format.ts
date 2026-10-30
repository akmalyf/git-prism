// PhpStorm-style text formatting (pure): pretty dates ("Today 11.19"), relative times, sizes, plurals, shortcuts.
// Numeric timestamps are unix seconds, like everything in core/types.ts.

export type Timestamp = number | Date;

let locale: string | undefined = typeof navigator !== 'undefined' ? navigator.language : undefined;
let cache: { dateTime: Intl.DateTimeFormat; date: Intl.DateTimeFormat; time: Intl.DateTimeFormat } | undefined;

/** Sets the locale used for dates/times (default: navigator.language). Pass undefined for the runtime default. */
export function setFormatLocale(l: string | undefined): void {
  locale = l;
  cache = undefined;
}

export function getFormatLocale(): string {
  return fmts().time.resolvedOptions().locale;
}

function fmts() {
  if (!cache) {
    const mk = (o: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(locale, o);
      } catch {
        return new Intl.DateTimeFormat(undefined, o);
      }
    };
    const date: Intl.DateTimeFormatOptions = { year: '2-digit', month: '2-digit', day: '2-digit' };
    const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    cache = { dateTime: mk({ ...date, ...time }), date: mk(date), time: mk(time) };
  }
  return cache;
}

export function toDate(t: Timestamp): Date {
  return t instanceof Date ? t : new Date(t * 1000);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Locale short date + time: "27/10/26, 10.27". */
export function formatDateTime(t: Timestamp): string {
  return fmts().dateTime.format(toDate(t));
}

/** Locale short date: "27/10/26". */
export function formatDate(t: Timestamp): string {
  return fmts().date.format(toDate(t));
}

/** Locale short time: "10.27". */
export function formatTime(t: Timestamp): string {
  return fmts().time.format(toDate(t));
}

/**
 * IntelliJ DateFormatUtil.formatPrettyDateTime: "Moments ago", "5 minutes ago" (within the last hour of today),
 * "Today 11.19", "Yesterday 14.53", otherwise "27/10/26, 10.27".
 */
export function formatPrettyDateTime(t: Timestamp, now: Timestamp = new Date()): string {
  const d = toDate(t);
  const n = toDate(now);
  const today = startOfDay(n);
  const time = d.getTime();
  if (time >= today && time < today + DAY) {
    const delta = n.getTime() - time;
    if (delta >= 0 && delta < MINUTE) return 'Moments ago';
    if (delta >= 0 && delta <= HOUR) return `${pluralize(Math.round(delta / MINUTE), 'minute')} ago`;
    return `Today ${formatTime(d)}`;
  }
  const yesterday = startOfDay(new Date(today - DAY / 2));
  if (time >= yesterday && time < today) return `Yesterday ${formatTime(d)}`;
  return formatDateTime(d);
}

/** Like formatPrettyDateTime but without the time part for older dates: "Today", "Yesterday", "27/10/26". */
export function formatPrettyDate(t: Timestamp, now: Timestamp = new Date()): string {
  const d = toDate(t);
  const today = startOfDay(toDate(now));
  const time = d.getTime();
  if (time >= today && time < today + DAY) return 'Today';
  if (time >= startOfDay(new Date(today - DAY / 2)) && time < today) return 'Yesterday';
  return formatDate(d);
}

/** "Moments ago", "5 minutes ago", "3 hours ago", "2 days ago", "4 months ago", "1 year ago" (or "in …" for the future). */
export function formatRelative(t: Timestamp, now: Timestamp = new Date()): string {
  const delta = toDate(now).getTime() - toDate(t).getTime();
  const abs = Math.abs(delta);
  let s: string;
  if (abs < MINUTE) return 'Moments ago';
  if (abs < HOUR) s = pluralize(Math.floor(abs / MINUTE), 'minute');
  else if (abs < DAY) s = pluralize(Math.floor(abs / HOUR), 'hour');
  else if (abs < 30 * DAY) s = pluralize(Math.floor(abs / DAY), 'day');
  else if (abs < 365 * DAY) s = pluralize(Math.floor(abs / (30 * DAY)), 'month');
  else s = pluralize(Math.floor(abs / (365 * DAY)), 'year');
  return delta >= 0 ? `${s} ago` : `in ${s}`;
}

/** IntelliJ StringUtil.formatFileSize-like: "0 B", "512 B", "1.5 kB", "12.3 MB". */
export function formatSize(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} B`;
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${String(Number(v.toFixed(digits)))} ${units[i]}`;
}

/** English plural of a noun for a count (simple rules + explicit plural). */
export function plural(word: string, count: number, pluralForm?: string): string {
  if (count === 1) return word;
  if (pluralForm) return pluralForm;
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  return word + 's';
}

/** "11 files", "1 file", "2 children" (with an explicit plural). */
export function pluralize(count: number, word: string, pluralForm?: string): string {
  return `${count} ${plural(word, count, pluralForm)}`;
}

export function shortHash(hash: string, length = 8): string {
  return hash.slice(0, length);
}

const MAC_KEYS: Record<string, string> = {
  cmd: '⌘', cmdorctrl: '⌘', meta: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
  enter: '↩', return: '↩', backspace: '⌫', delete: '⌦', escape: '⎋', esc: '⎋', tab: '⇥',
  up: '↑', down: '↓', left: '←', right: '→', pageup: '⇞', pagedown: '⇟', home: '↖', end: '↘', space: 'Space',
};
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];
const OTHER_KEYS: Record<string, string> = {
  cmdorctrl: 'Ctrl', cmd: 'Ctrl', meta: 'Meta', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  esc: 'Escape', return: 'Enter', pageup: 'Page Up', pagedown: 'Page Down',
};

/**
 * Formats an accelerator ('CmdOrCtrl+Alt+K', 'Shift+F10'): macOS "⌥⌘K" (IntelliJ order ⌃⌥⇧⌘), others "Ctrl+Alt+K".
 * Several chords may be separated by a space ('CmdOrCtrl+K CmdOrCtrl+S').
 */
export function formatShortcut(accel: string, mac = isMacPlatform()): string {
  return accel
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+').filter(Boolean);
      if (mac) {
        const mods: string[] = [];
        const keys: string[] = [];
        for (const p of parts) {
          const m = MAC_KEYS[p.toLowerCase()];
          if (m && MAC_ORDER.includes(m)) mods.push(m);
          else keys.push(m ?? (p.length === 1 ? p.toUpperCase() : p));
        }
        mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
        return mods.join('') + keys.join('');
      }
      return parts.map((p) => OTHER_KEYS[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p)).join('+');
    })
    .join(', ');
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const p = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  return /mac/i.test(p) || /Macintosh/.test(navigator.userAgent ?? '');
}
