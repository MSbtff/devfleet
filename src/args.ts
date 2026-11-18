export interface Args {
  _: string[];
  [flag: string]: string | boolean | string[] | undefined;
}

const VALUE_FLAGS = new Set(['config', 'only', 'n']);
const ALIASES: Record<string, string> = { c: 'config', q: 'quiet', f: 'follow', h: 'help', v: 'version' };

/** Parses command-line arguments. Throws when an option that needs a value has none. */
export function parseArgs(argv: readonly string[]): Args {
  const opts: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    const long = arg.match(/^--([^=]+)(?:=(.*))?$/);
    const short = arg.match(/^-([A-Za-z])$/);
    if (!long && !short) {
      opts._.push(arg);
      continue;
    }
    const key = long ? long[1]! : (ALIASES[short![1]!] ?? short![1]!);
    if (key.startsWith('no-')) {
      opts[key.slice(3)] = false;
      continue;
    }
    if (VALUE_FLAGS.has(key)) {
      const value = long?.[2] ?? argv[++i];
      if (value == null) throw new Error(`--${key} needs a value.`);
      opts[key] = value;
    } else {
      opts[key] = long?.[2] ?? true;
    }
  }
  return opts;
}
