// Pure helpers of the Git panel "Console" tab: turns what src/core/console.ts writes to the Git Console channel
// into typed lines (command / error output / plain output), keeps a bounded buffer and formats timestamps
// like IntelliJ's VcsConsoleView ("14:03:21.234: [project] git status"). Shared by host and webview.

export type ConsoleKind = 'command' | 'output' | 'warning' | 'error';

export interface ConsoleLine {
  /** increasing id, used to de-duplicate snapshot + stream in the webview */
  id: number;
  /** unix milliseconds */
  time: number;
  kind: ConsoleKind;
  text: string;
  /** command lines: duration in ms and exit code (when it failed) */
  ms?: number;
  exit?: number;
}

export type ConsoleLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'append';

export type ParsedLine = Omit<ConsoleLine, 'id' | 'time'>;

// "[repo] git args  (12 ms)" optionally followed by " → exit 128"
const COMMAND_RE = /^(\[[^\]\n]*\] git(?: .*)?)  \((\d+) ms\)(?: → exit (-?\d+))?$/;

/** Splits one message written to the console channel into display lines. */
export function parseConsoleMessage(level: ConsoleLevel, message: string): ParsedLine[] {
  const lines = message.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length === 1 && lines[0] === '') return [];
  const out: ParsedLine[] = [];
  const m = COMMAND_RE.exec(lines[0]);
  let rest = lines;
  if (m) {
    const line: ParsedLine = { kind: 'command', text: m[1], ms: Number(m[2]) };
    if (m[3] !== undefined) line.exit = Number(m[3]);
    out.push(line);
    rest = lines.slice(1);
    const errors = rest.filter((l) => l.trim() !== '');
    if (line.exit !== undefined && !errors.length) out.push({ kind: 'error', text: `exit code ${line.exit}` });
    for (const l of errors) out.push({ kind: line.exit !== undefined ? 'error' : 'output', text: l });
    return out;
  }
  const kind: ConsoleKind = level === 'error' ? 'error' : level === 'warn' ? 'warning' : 'output';
  for (const l of rest) out.push({ kind, text: l });
  return out;
}

/** Bounded line buffer (oldest lines dropped first). */
export class ConsoleBuffer {
  private lines: ConsoleLine[] = [];
  private seq = 0;

  constructor(readonly limit = 5000) {}

  /** Adds parsed lines stamped with `time`; returns the stored lines. */
  push(parsed: ParsedLine[], time: number): ConsoleLine[] {
    const added = parsed.map((p) => ({ ...p, id: ++this.seq, time }));
    this.lines.push(...added);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    return added;
  }

  clear(): void {
    this.lines = [];
  }

  get all(): readonly ConsoleLine[] {
    return this.lines;
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "HH:mm:ss.SSS" in local time, as IntelliJ's console timestamps. */
export function formatConsoleTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Plain-text form of lines (Copy / Copy All). */
export function consoleText(lines: readonly ConsoleLine[], timestamps: boolean): string {
  return lines.map((l) => (timestamps && l.kind === 'command' ? `${formatConsoleTime(l.time)}: ${l.text}` : l.text)).join('\n');
}
