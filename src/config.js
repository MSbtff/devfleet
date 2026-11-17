import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { findCycle } from './graph.js';

export const CONFIG_NAMES = ['devfleet.yaml', 'devfleet.yml'];
const DEFAULT_HEALTH_TIMEOUT = 180;

/** 현재 폴더부터 상위로 올라가며 설정 파일을 찾는다. */
export function findConfig(start = process.cwd()) {
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
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '');
    }
    env[match[1]] = value;
  }
  return env;
}

export function readEnvFile(file) {
  if (!file) return {};
  if (!fs.existsSync(file)) throw new Error(`env 파일을 찾을 수 없습니다: ${file}`);
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

export function loadConfig(file) {
  const root = path.dirname(path.resolve(file));
  let raw;
  try {
    raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new Error(`${path.basename(file)}을 읽을 수 없습니다: ${err.message}`);
  }
  const config = normalizeConfig(raw, root);
  config.file = path.resolve(file);
  return config;
}

export function normalizeConfig(raw, root) {
  const errors = [];
  const services = {};
  const rawServices = raw.services ?? {};
  if (typeof rawServices !== 'object' || Array.isArray(rawServices)) {
    errors.push('services는 "이름: 설정" 형태여야 합니다.');
  } else {
    for (const [name, s] of Object.entries(rawServices)) {
      if (!s || typeof s !== 'object') {
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
        envFile: s.env_file ? path.resolve(root, s.env_file) : null,
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

  const groups = {};
  for (const [group, list] of Object.entries(raw.groups ?? {})) {
    if (services[group]) errors.push(`groups.${group}: 서비스 이름과 같은 그룹 이름은 쓸 수 없습니다.`);
    groups[group] = toList(list);
    for (const name of groups[group]) {
      if (!services[name]) errors.push(`groups.${group}: 정의되지 않은 서비스 '${name}'가 있습니다.`);
    }
  }

  let infra = null;
  if (raw.infra) {
    infra = {
      composeFiles: toList(raw.infra.compose_files ?? raw.infra.compose_file ?? 'compose.yaml').map((f) =>
        path.resolve(root, f),
      ),
      services: toList(raw.infra.services),
      stopOnExit: Boolean(raw.infra.stop_on_exit),
    };
  }

  return {
    root,
    envFile: raw.env_file ? path.resolve(root, raw.env_file) : null,
    env: stringifyEnv(raw.env),
    services,
    groups,
    infra,
    logDir: path.resolve(root, raw.log_dir ?? '.devfleet/logs'),
    errors,
  };
}

function normalizeHealth(health, port, name, errors) {
  const base = { timeout: DEFAULT_HEALTH_TIMEOUT, interval: 1 };
  if (health == null) return port ? { ...base, type: 'tcp', port } : { ...base, type: 'none' };
  if (typeof health === 'string') {
    if (/^https?:\/\//.test(health)) return { ...base, type: 'http', url: health };
    if (health === 'none') return { ...base, type: 'none' };
    if (health === 'tcp' && port) return { ...base, type: 'tcp', port };
    errors.push(`${name}: health는 http(s) 주소, "tcp", "none" 중 하나여야 합니다.`);
    return { ...base, type: 'none' };
  }
  const merged = {
    ...base,
    timeout: Number(health.timeout ?? base.timeout),
    interval: Number(health.interval ?? base.interval),
  };
  if (health.http) return { ...merged, type: 'http', url: String(health.http) };
  if (health.tcp) return { ...merged, type: 'tcp', port: Number(health.tcp) };
  if (port) return { ...merged, type: 'tcp', port };
  return { ...merged, type: 'none' };
}

function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') return Object.keys(value);
  return [String(value)];
}

function stringifyEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env ?? {})) result[key] = value == null ? '' : String(value);
  return result;
}
