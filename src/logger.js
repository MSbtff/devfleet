import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const COLORS = [36, 33, 32, 35, 34, 96, 93, 92, 95, 94];
const TAIL_LINES = 30;
const SYSTEM = 'devfleet';

export class Logger {
  constructor({ out = process.stdout, color, names = [], logDir = null, quiet = false, only = null } = {}) {
    this.out = out;
    this.color = color ?? Boolean(out.isTTY && !process.env.NO_COLOR);
    this.logDir = logDir;
    this.quiet = quiet;
    this.only = only ? new Set(only) : null;
    this.width = Math.max(SYSTEM.length, ...names.map((n) => n.length));
    this.colorOf = new Map(names.map((n, i) => [n, COLORS[i % COLORS.length]]));
    this.files = new Map();
    this.tails = new Map();
    if (logDir) fs.mkdirSync(logDir, { recursive: true });
  }

  paint(code, text) {
    return this.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  }

  prefix(name) {
    return `${this.paint(this.colorOf.get(name) ?? 90, name.padEnd(this.width))} │ `;
  }

  logFile(name) {
    return this.logDir ? path.join(this.logDir, `${name}.log`) : null;
  }

  file(name) {
    if (!this.logDir) return null;
    if (!this.files.has(name)) this.files.set(name, fs.createWriteStream(this.logFile(name), { flags: 'w' }));
    return this.files.get(name);
  }

  /** 프로세스 출력 한 줄. 파일에는 항상 쓰고, 화면에는 옵션에 따라 보여준다. */
  line(name, text) {
    this.file(name)?.write(`${text}\n`);
    const tail = this.tails.get(name) ?? [];
    tail.push(text);
    if (tail.length > TAIL_LINES) tail.shift();
    this.tails.set(name, tail);
    if (this.isVisible(name)) this.out.write(`${this.prefix(name)}${text}\n`);
  }

  isVisible(name) {
    return !this.quiet && (!this.only || this.only.has(name));
  }

  attach(name, stream) {
    readline.createInterface({ input: stream, crlfDelay: Infinity }).on('line', (text) => this.line(name, text));
  }

  /** 출력이 숨겨져 있던 서비스가 실패했을 때 마지막 로그를 보여준다. */
  dumpTail(name) {
    if (this.isVisible(name)) return;
    const tail = this.tails.get(name) ?? [];
    if (!tail.length) return;
    this.system(this.paint(90, `── ${name} 마지막 로그 ${tail.length}줄 ──`));
    for (const text of tail) this.out.write(`${this.prefix(name)}${text}\n`);
  }

  system(text) {
    this.out.write(`${this.paint(90, SYSTEM.padEnd(this.width))} │ ${text}\n`);
  }

  info(name, text) {
    this.system(`${this.paint(this.colorOf.get(name) ?? 1, name)} ${text}`);
  }

  ok(name, text) {
    this.system(`${this.paint(32, '✔')} ${this.paint(this.colorOf.get(name) ?? 1, name)} ${text}`);
  }

  warn(name, text) {
    this.system(`${this.paint(33, '!')} ${this.paint(this.colorOf.get(name) ?? 1, name)} ${text}`);
  }

  error(name, text) {
    this.system(`${this.paint(31, '✖')} ${this.paint(this.colorOf.get(name) ?? 1, name)} ${text}`);
  }

  close() {
    return Promise.all([...this.files.values()].map((f) => new Promise((resolve) => f.end(resolve))));
  }
}
