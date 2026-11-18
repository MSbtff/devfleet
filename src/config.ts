import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { findCycle } from './graph.ts';
import { isRecord, type Config, type Health, type Infra, type Service } from './types.ts';

export const CONFIG_NAMES = ['devfleet.yaml', 'devfleet.yml'] as const;
const DEFAULT_HEALTH_TIMEOUT = 180;

/** 현재 폴더부터 상위로 올라가며 설정 파일을 찾는다. */
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

/** `set -a; source .env`로 읽히는 단순한 KEY=VALUE 형식을 해석한다. */
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
  if (!fs.existsSync(file)) throw new Error(`env 파일을 찾을 수 없습니다: ${file}`);
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

export function loadConfig(file: string): Config {
  const root = path.dirname(path.resolve(file));
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new Error(`${path.basename(file)}을 읽을 수 없습니다: ${(err as Error).message}`);
  }
  const config = normalizeConfig(raw, root);
  config.file = path.resolve(file);
  return config;
}

/** YAML에서 읽은 값을 검증하고 내부 형식으로 바꾼다. 문제는 throw하지 않고 errors에 모은다. */
export function normalizeConfig(raw: unknown, root: string): Config {
  const errors: string[] = [];
  const data = isRecord(raw) ? raw : {};
  if (raw != null && !isRecord(raw)) errors.push('설정 파일의 최상위는 "키: 값" 형태여야 합니다.');

  const services: Record<string, Service> = {};
  const rawServices = data.services ?? {};
  if (!isRecord(rawServices)) {
    errors.push('services는 "이름: 설정" 형태여야 합니다.');
  } else {
    for (const [name, s] of Object.entries(rawServices)) {
      if (!isRecord(s)) {
        errors.push(`${name}: 설정이 비어 있습니다.`);
        continue;
      }
      if (!s.cmd) errors.push(`${name}: cmd가 필요합니다.`);
      const port = s.port == null ? null : Number(s.port);
      if (port != null && !(Number.isInteger(port) && port > 0 && port < 65536)) {
        errors.push(`${name}: port는 1~65535 사이 정수여야 합니다.`);
      }
      services[name] = {
        name,
        dir: path.resolve(root, String(s.dir ?? '.')),
        cmd: s.cmd == null ? '' : String(s.cmd),
        env: stringifyEnv(s.env),
        envFile: s.env_file ? path.resolve(root, String(s.env_file)) : null,
        dependsOn: toList(s.depends_on),
        port,
        health: normalizeHealth(s.health, port, name, errors),
        stopTimeout: Number(s.stop_timeout ?? 15),
      };
    }
  }

  for (const svc of Object.values(services)) {
    for (const dep of svc.dependsOn) {
      if (!services[dep]) errors.push(`${svc.name}: depends_on에 정의되지 않은 서비스 '${dep}'가 있습니다.`);
    }
  }
  const cycle = errors.length ? null : findCycle(services);
  if (cycle) errors.push(`순환 의존성이 있습니다: ${cycle.join(' → ')}`);

  const groups: Record<string, string[]> = {};
  for (const [group, list] of Object.entries(isRecord(data.groups) ? data.groups : {})) {
    if (services[group]) errors.push(`groups.${group}: 서비스 이름과 같은 그룹 이름은 쓸 수 없습니다.`);
    groups[group] = toList(list);
    for (const name of groups[group]) {
      if (!services[name]) errors.push(`groups.${group}: 정의되지 않은 서비스 '${name}'가 있습니다.`);
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
    errors.push(`${name}: health는 http(s) 주소, "tcp", "none" 중 하나여야 합니다.`);
    return { ...base, type: 'none' };
  }
  if (!isRecord(health)) {
    errors.push(`${name}: health 형식이 올바르지 않습니다.`);
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
