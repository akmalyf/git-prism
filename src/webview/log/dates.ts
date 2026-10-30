// Date texts of the Git Log (pure): the Date column (pretty "Today 11.19" / locale / custom pattern like the
// VCS Log "Date format" setting) and the details pane ("on 27/10/26 at 10.27").
import { formatDate, formatDateTime, formatPrettyDateTime, formatTime, toDate } from '../shared/ui/format';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Formats with a pattern made of yyyy yy MM M dd d HH H mm ss (other characters are copied; 'text' is literal). */
export function formatPattern(t: number | Date, pattern: string): string {
  const d = toDate(t);
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const rest = pattern.slice(i);
    if (rest[0] === "'") {
      const end = pattern.indexOf("'", i + 1);
      out += end < 0 ? pattern.slice(i + 1) : pattern.slice(i + 1, end);
      i = end < 0 ? pattern.length : end + 1;
      continue;
    }
    const tok = /^(yyyy|yy|MM|M|dd|d|HH|H|mm|ss)/.exec(rest)?.[1];
    if (!tok) {
      out += rest[0];
      i++;
      continue;
    }
    switch (tok) {
      case 'yyyy':
        out += pad(d.getFullYear(), 4);
        break;
      case 'yy':
        out += pad(d.getFullYear() % 100);
        break;
      case 'MM':
        out += pad(d.getMonth() + 1);
        break;
      case 'M':
        out += String(d.getMonth() + 1);
        break;
      case 'dd':
        out += pad(d.getDate());
        break;
      case 'd':
        out += String(d.getDate());
        break;
      case 'HH':
        out += pad(d.getHours());
        break;
      case 'H':
        out += String(d.getHours());
        break;
      case 'mm':
        out += pad(d.getMinutes());
        break;
      case 'ss':
        out += pad(d.getSeconds());
        break;
    }
    i += tok.length;
  }
  return out;
}

export interface DateSettings {
  dateFormat: string;
  prettyDates: boolean;
}

/** Text of the Date column. */
export function formatLogDate(t: number, s: DateSettings, now: Date = new Date()): string {
  if (!t) return '';
  if (s.dateFormat.trim()) return formatPattern(t, s.dateFormat);
  return s.prettyDates ? formatPrettyDateTime(t, now) : formatDateTime(t);
}

/** "on 27/10/26 at 10.27" parts for the details pane / tooltips. */
export function dateAndTime(t: number): { date: string; time: string } {
  return { date: formatDate(t), time: formatTime(t) };
}
