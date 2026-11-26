import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { findCycle } from './graph.ts';
import { isRecord, type Build, type Config, type Health, type Infra, type RestartPolicy, type Service } from './types.ts';

export const CONFIG_NAMES = ['devfleet.yaml', 'devfleet.yml'] as const;
const DEFAULT_HEALTH_TIMEOUT = 180;
const DEFAULT_MAX_RESTARTS = 3;

/** Looks for the config file from the current folder upwards. */
export function findConfig(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Parses the simple KEY=VALUE format that `set -a; source .env` understands. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match as [string, string, string];
    let value = rawValue;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[key] = value;
  }
  return env;
}

export function readEnvFile(file: string | null): Record<string, string> {
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`env file not found: ${file}`);
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

export function loadConfig(file: string): Config {
  const root = path.dirname(path.resolve(file));
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new Error(`Cannot read ${path.basename(file)}: ${(err as Error).message}`);
  }
  const config = normalizeConfig(raw, root);
  config.file = path.resolve(file);
  return config;
}

/** Validates the parsed YAML and converts it to the internal form. Problems are collected in errors instead of thrown. */
export function normalizeConfig(raw: unknown, root: string): Config {
  const errors: string[] = [];
  const data = isRecord(raw) ? raw : {};
  if (raw != null && !isRecord(raw)) errors.push('The top level of the config file must be a "key: value" mapping.');

  const defaults = {
    restart: normalizeRestart(data.restart, 'restart', 'no', errors),
    maxRestarts: normalizeCount(data.max_restarts, 'max_restarts', DEFAULT_MAX_RESTARTS, errors),
  };
  const services: Record<string, Service> = {};
  const rawServices = data.services ?? {};
  if (!isRecord(rawServices)) {
    errors.push('services must be a "name: settings" mapping.');
  } else {
    for (const [name, s] of Object.entries(rawServices)) {
      if (!isRecord(s)) {
        errors.push(`${name}: settings are empty.`);
        continue;
      }
      if (s.cmd && s.jar) errors.push(`${name}: use either cmd or jar, not both.`);
      else if (!s.cmd && !s.jar) errors.push(`${name}: cmd is required (or jar, to run a jar with java -jar).`);
      const dir = path.resolve(root, String(s.dir ?? '.'));
      const port = s.port == null ? null : Number(s.port);
      if (port != null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        errors.push(`${name}: port must be an integer between 1 and 65535.`);
      }
      services[name] = {
        name,
        dir,
        cmd: s.cmd == null ? '' : String(s.cmd),
        build: normalizeBuild(s.build, dir, root, name, errors),
        jar: normalizeJar(s.jar, name, errors),
        javaOpts: s.java_opts == null ? '' : String(s.java_opts),
        env: stringifyEnv(s.env),
        envFile: s.env_file ? path.resolve(root, String(s.env_file)) : null,
        dependsOn: toList(s.depends_on),
        port,
        health: normalizeHealth(s.health, port, name, errors),
        stopTimeout: Number(s.stop_timeout ?? 15),
        restart: normalizeRestart(s.restart, `${name}: restart`, defaults.restart, errors),
        maxRestarts: normalizeCount(s.max_restarts, `${name}: max_restarts`, defaults.maxRestarts, errors),
      };
    }
  }

  for (const svc of Object.values(services)) {
    for (const dep of svc.dependsOn) {
      if (!services[dep]) errors.push(`${svc.name}: depends_on refers to undefined service '${dep}'.`);
    }
  }
  const cycle = errors.length ? null : findCycle(services);
  if (cycle) errors.push(`Dependency cycle: ${cycle.join(' → ')}`);

  const groups: Record<string, string[]> = {};
  for (const [group, list] of Object.entries(isRecord(data.groups) ? data.groups : {})) {
    if (services[group]) errors.push(`groups.${group}: a group cannot have the same name as a service.`);
    groups[group] = toList(list);
    for (const name of groups[group]) {
      if (!services[name]) errors.push(`groups.${group}: refers to undefined service '${name}'.`);
    }
  }

  let infra: Infra | null = null;
  if (isRecord(data.infra)) {
    infra = {
      composeFiles: toList(data.infra.compose_files ?? data.infra.compose_file ?? 'compose.yaml').map((f) =>
        path.resolve(root, f),
      ),
      services: toList(data.infra.services),
      stopOnExit: Boolean(data.infra.stop_on_exit),
      timeout: Number(data.infra.timeout ?? DEFAULT_HEALTH_TIMEOUT),
    };
  }

  return {
    root,
    envFile: data.env_file ? path.resolve(root, String(data.env_file)) : null,
    env: stringifyEnv(data.env),
    services,
    groups,
    infra,
    logDir: path.resolve(root, String(data.log_dir ?? '.devfleet/logs')),
    buildConcurrency: normalizeCount(data.build_concurrency, 'build_concurrency', 1, errors) || 1,
    errors,
  };
}

function normalizeHealth(health: unknown, port: number | null, name: string, errors: string[]): Health {
  const base = { timeout: DEFAULT_HEALTH_TIMEOUT, interval: 1 };
  if (health == null) return port ? { ...base, type: 'tcp', port } : { ...base, type: 'none' };
  if (typeof health === 'string') {
    if (/^https?:\/\//.test(health)) return { ...base, type: 'http', url: health };
    if (health === 'none') return { ...base, type: 'none' };
    if (health === 'tcp' && port) return { ...base, type: 'tcp', port };
    errors.push(`${name}: health must be an http(s) URL, "tcp", or "none".`);
    return { ...base, type: 'none' };
  }
  if (!isRecord(health)) {
    errors.push(`${name}: invalid health setting.`);
    return { ...base, type: 'none' };
  }
  const merged = {
    timeout: Number(health.timeout ?? base.timeout),
    interval: Number(health.interval ?? base.interval),
  };
  if (health.http) return { ...merged, type: 'http', url: String(health.http) };
  if (health.tcp) return { ...merged, type: 'tcp', port: Number(health.tcp) };
  if (port) return { ...merged, type: 'tcp', port };
  return { ...merged, type: 'none' };
}

function normalizeBuild(value: unknown, dir: string, root: string, name: string, errors: string[]): Build | null {
  if (value == null || value === '') return null;
  if (typeof value === 'string') return { cmd: value, dir };
  if (isRecord(value) && typeof value.cmd === 'string' && value.cmd) {
    // build.dir is relative to the config file, like the service's own dir.
    return { cmd: value.cmd, dir: value.dir == null ? dir : path.resolve(root, String(value.dir)) };
  }
  errors.push(`${name}: build must be a shell command or { cmd, dir }.`);
  return null;
}

function normalizeJar(value: unknown, name: string, errors: string[]): string | null {
  if (value == null || value === '') return null;
  const jar = String(value);
  if (path.dirname(jar).includes('*')) {
    errors.push(`${name}: jar may use * only in the file name, e.g. build/libs/*.jar.`);
    return null;
  }
  return jar;
}

function normalizeRestart(value: unknown, label: string, fallback: RestartPolicy, errors: string[]): RestartPolicy {
  if (value == null) return fallback;
  if (value === false || value === 'no') return 'no';
  if (value === 'on-failure') return 'on-failure';
  errors.push(`${label} must be "no" or "on-failure".`);
  return fallback;
}

function normalizeCount(value: unknown, label: string, fallback: number, errors: string[]): number {
  if (value == null) return fallback;
  const count = Number(value);
  if (Number.isInteger(count) && count >= 0) return count;
  errors.push(`${label} must be a whole number of 0 or more.`);
  return fallback;
}

function toList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (isRecord(value)) return Object.keys(value);
  return [String(value)];
}

function stringifyEnv(env: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!isRecord(env)) return result;
  for (const [key, value] of Object.entries(env)) result[key] = value == null ? '' : String(value);
  return result;
}
