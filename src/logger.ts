import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';

const COLORS = [36, 33, 32, 35, 34, 96, 93, 92, 95, 94];
const TAIL_LINES = 30;
const SYSTEM = 'devfleet';

export type Output = Writable & { isTTY?: boolean };

export interface LoggerOptions {
  out?: Output;
  color?: boolean;
  names?: readonly string[];
  logDir?: string | null;
  quiet?: boolean;
  only?: readonly string[] | null;
}

export class Logger {
  private readonly out: Output;
  private readonly color: boolean;
  private readonly logDir: string | null;
  private readonly quiet: boolean;
  private readonly only: Set<string> | null;
  private readonly width: number;
  private readonly colorOf: Map<string, number>;
  private readonly files = new Map<string, fs.WriteStream>();
  private readonly tails = new Map<string, string[]>();

  constructor({ out = process.stdout, color, names = [], logDir = null, quiet = false, only = null }: LoggerOptions = {}) {
    this.out = out;
    this.color = color ?? Boolean(out.isTTY && !process.env.NO_COLOR);
    this.logDir = logDir;
    this.quiet = quiet;
    this.only = only ? new Set(only) : null;
    this.width = Math.max(SYSTEM.length, ...names.map((n) => n.length));
    this.colorOf = new Map(names.map((n, i) => [n, COLORS[i % COLORS.length] ?? 36]));
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
  }

  paint(code: number, text: string): string {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  private prefix(name: string): string {
    return `${this.paint(this.colorOf.get(name) ?? 90, name.padEnd(this.width))} │ `;
  }

  logFile(name: string): string | null {
    return this.logDir ? path.join(this.logDir, `${name}.log`) : null;
  }

  private file(name: string): fs.WriteStream | null {
    const file = this.logFile(name);
    if (!file) return null;
    let stream = this.files.get(name);
    if (!stream) {
      stream = fs.createWriteStream(file, { flags: 'w' });
      this.files.set(name, stream);
    }
    return stream;
  }

  /** One line of process output. Always written to the file; shown on screen depending on options. */
  line(name: string, text: string): void {
    this.file(name)?.write(`${text}\n`);
    const tail = this.tails.get(name) ?? [];
    tail.push(text);
    if (tail.length > TAIL_LINES) tail.shift();
    this.tails.set(name, tail);
    if (this.isVisible(name)) this.out.write(`${this.prefix(name)}${text}\n`);
  }

  isVisible(name: string): boolean {
    return !this.quiet && (!this.only || this.only.has(name));
  }

  attach(name: string, stream: Readable | null): void {
    if (!stream) return;
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (text) => this.line(name, text));
  }

  /** Shows the last log lines of a service whose output was hidden, after it fails. */
  dumpTail(name: string): void {
    if (this.isVisible(name)) return;
    const tail = this.tails.get(name) ?? [];
    if (!tail.length) return;
    this.system(this.paint(90, `── last ${tail.length} lines of ${name} ──`));
    for (const text of tail) this.out.write(`${this.prefix(name)}${text}\n`);
  }

  system(text: string): void {
    this.out.write(`${this.paint(90, SYSTEM.padEnd(this.width))} │ ${text}\n`);
  }

  private tag(name: string): string {
    return this.paint(this.colorOf.get(name) ?? 1, name);
  }

  info(name: string, text: string): void {
    this.system(`${this.tag(name)} ${text}`);
  }

  ok(name: string, text: string): void {
    this.system(`${this.paint(32, '✔')} ${this.tag(name)} ${text}`);
  }

  warn(name: string, text: string): void {
    this.system(`${this.paint(33, '!')} ${this.tag(name)} ${text}`);
  }

  error(name: string, text: string): void {
    this.system(`${this.paint(31, '✖')} ${this.tag(name)} ${text}`);
  }

  async close(): Promise<void> {
    await Promise.all([...this.files.values()].map((f) => new Promise<void>((resolve) => f.end(resolve))));
  }
}
