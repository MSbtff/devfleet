import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { parseEnv } from './config.js';
import { waves } from './graph.js';

const SKIP_DIRS = new Set(['node_modules', 'build', 'target', 'out', 'bin', 'dist', 'gradle', 'src']);
const BUILD_FILES = ['build.gradle.kts', 'build.gradle', 'pom.xml'];
const APP_CONFIGS = ['application.yml', 'application.yaml', 'application.properties'];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const MAX_DEPTH = 3;

/** 프로젝트를 훑어 Spring Boot 앱과 Compose 구성을 찾고 devfleet 설정 초안을 만든다. */
export function detectProject(root, { useDocker = true } = {}) {
  root = path.resolve(root);
  const envFile = fs.existsSync(path.join(root, '.env')) ? '.env' : null;
  const envVars = envFile ? parseEnv(fs.readFileSync(path.join(root, envFile), 'utf8')) : {};
  const apps = [];
  walk(root, 0, apps, root);
  for (const app of apps) Object.assign(app, describeApp(app, root, envVars));

  const compose = loadCompose(root, useDocker);
  const byDir = new Map(apps.map((a) => [a.dir, a]));
  const composeToApp = new Map();
  if (compose) {
    for (const svc of Object.values(compose.services)) {
      const app = svc.buildDir && byDir.get(svc.buildDir);
      if (app && !app.composeName) {
        app.composeName = svc.name;
        composeToApp.set(svc.name, app);
      }
    }
  }

  const usedNames = new Set();
  for (const app of apps) {
    let name = app.composeName ?? kebab(path.basename(app.dir));
    while (usedNames.has(name)) name += '-2';
    usedNames.add(name);
    app.name = name;
  }

  const infra = new Set();
  for (const app of apps) {
    app.dependsOn = [];
    if (app.composeName) {
      const visit = (dep) => {
        const target = composeToApp.get(dep);
        if (target) {
          if (!app.dependsOn.includes(target.name)) app.dependsOn.push(target.name);
          return;
        }
        if (infra.has(dep) || !compose.services[dep]) return;
        infra.add(dep);
        compose.services[dep].dependsOn.forEach(visit);
      };
      compose.services[app.composeName].dependsOn.forEach(visit);
    }
  }
  // Compose에 없으면 Eureka 의존성으로 순서를 추정한다.
  const eurekaServer = apps.find((a) => a.isEurekaServer);
  if (eurekaServer) {
    for (const app of apps) {
      if (!app.composeName && app !== eurekaServer && app.usesEureka && !app.dependsOn.includes(eurekaServer.name)) {
        app.dependsOn.push(eurekaServer.name);
      }
    }
  }

  return {
    root,
    envFile,
    apps,
    composeFile: compose?.file ?? null,
    infra: compose ? Object.keys(compose.services).filter((n) => infra.has(n)) : [],
  };
}

function walk(dir, depth, acc, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const names = new Set(entries.map((e) => e.name));
  const buildFile = BUILD_FILES.find((f) => names.has(f));
  if (buildFile) {
    const resources = path.join(dir, 'src', 'main', 'resources');
    const appConfig = APP_CONFIGS.map((f) => path.join(resources, f)).find((f) => fs.existsSync(f));
    const buildText = fs.readFileSync(path.join(dir, buildFile), 'utf8');
    if (appConfig && /org\.springframework\.boot|spring-boot/.test(buildText)) {
      acc.push({ dir, buildFile, buildText, appConfig });
    }
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
      walk(path.join(dir, entry.name), depth + 1, acc, root);
    }
  }
}

function describeApp(app, root, envVars) {
  const props = readSpringProps(app.appConfig);
  const resolve = (key) => (props[key] == null ? null : resolvePlaceholders(String(props[key]), envVars));
  const port = toPort(resolve('server.port')) ?? 8080;
  const managementPort = toPort(resolve('management.server.port'));
  const basePath = trimSlash(resolve('management.endpoints.web.base-path') ?? '/actuator');
  const contextPath = trimSlash(resolve('server.servlet.context-path') ?? '');
  const hasActuator = /spring-boot-starter-actuator/.test(app.buildText);
  const health = hasActuator
    ? managementPort && managementPort !== port
      ? `http://127.0.0.1:${managementPort}${basePath}/health`
      : `http://127.0.0.1:${port}${contextPath}${basePath}/health`
    : null;
  return {
    port,
    health,
    ...runCommand(app, root),
    isEurekaServer: /eureka-server/.test(app.buildText),
    usesEureka: /eureka-client|spring-cloud-starter-gateway/.test(app.buildText),
  };
}

function runCommand(app, root) {
  const gradle = app.buildFile !== 'pom.xml';
  const wrapper = gradle ? 'gradlew' : 'mvnw';
  const task = gradle ? 'bootRun' : 'spring-boot:run';
  if (fs.existsSync(path.join(app.dir, wrapper))) return { runDir: app.dir, cmd: `./${wrapper} ${task}` };
  // 루트(멀티 모듈)의 래퍼를 찾아 하위 프로젝트를 지정해 실행한다.
  for (let dir = path.dirname(app.dir); dir.startsWith(root); dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, wrapper))) {
      const rel = path.relative(dir, app.dir).split(path.sep);
      const cmd = gradle ? `./gradlew :${rel.join(':')}:bootRun` : `./mvnw -pl ${rel.join('/')} spring-boot:run`;
      return { runDir: dir, cmd };
    }
    if (dir === root) break;
  }
  return { runDir: app.dir, cmd: gradle ? 'gradle bootRun' : 'mvn spring-boot:run' };
}

/** application.yml/properties에서 기본 프로필 값을 평평한 key 맵으로 읽는다. */
export function readSpringProps(file) {
  const text = fs.readFileSync(file, 'utf8');
  const result = {};
  if (file.endsWith('.properties')) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('!')) continue;
      const match = line.match(/^([^=:\s]+)\s*[=:]\s*(.*)$/);
      if (match) result[match[1]] = match[2];
    }
    return result;
  }
  for (const doc of YAML.parseAllDocuments(text)) {
    const value = doc.toJS();
    if (!value || typeof value !== 'object') continue;
    const flat = {};
    flatten(value, '', flat);
    if (flat['spring.config.activate.on-profile'] || flat['spring.profiles']) continue;
    Object.assign(result, flat);
  }
  return result;
}

function flatten(value, prefix, out) {
  for (const [key, child] of Object.entries(value)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, full, out);
    else out[full] = child;
  }
}

/** ${NAME:default} 형식을 .env 값 또는 기본값으로 바꾼다. */
export function resolvePlaceholders(text, env) {
  return text.replace(/\$\{([^:}]+)(?::([^}]*))?\}/g, (_, key, fallback) => env[key] ?? fallback ?? '');
}

function loadCompose(root, useDocker) {
  const file = COMPOSE_FILES.find((f) => fs.existsSync(path.join(root, f)));
  if (!file) return null;
  let doc = null;
  if (useDocker) {
    // docker compose config는 데몬 없이도 동작하며 extends/include/환경변수를 모두 반영해 준다.
    const res = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20_000,
    });
    if (res.status === 0) {
      try {
        doc = JSON.parse(res.stdout);
      } catch {
        doc = null;
      }
    }
  }
  if (!doc) {
    try {
      doc = YAML.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch {
      return null;
    }
  }
  const services = {};
  for (const [name, s] of Object.entries(doc?.services ?? {})) {
    let buildDir = null;
    if (s.build) {
      const build = typeof s.build === 'string' ? { context: s.build } : s.build;
      const context = path.resolve(root, build.context ?? '.');
      buildDir = build.dockerfile ? path.dirname(path.resolve(context, build.dockerfile)) : context;
    }
    const dependsOn = Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on ?? {});
    services[name] = { name, buildDir, dependsOn };
  }
  return { file, services };
}

export function renderConfig(project) {
  const lines = [
    '# devfleet 설정 파일 — `devfleet init`이 만든 초안입니다. 필요에 맞게 고쳐 쓰세요.',
    '# 실행: devfleet up [서비스 또는 그룹 ...]',
    '',
  ];
  if (project.envFile) lines.push(`# 모든 서비스에 넣을 환경변수 파일`, `env_file: ${scalar(project.envFile)}`, '');
  if (project.composeFile && project.infra.length) {
    lines.push(
      '# 앱보다 먼저 Docker Compose로 띄울 인프라 (DB, 캐시, 메시지 브로커 등)',
      'infra:',
      `  compose_file: ${scalar(project.composeFile)}`,
      `  services: [${project.infra.map(scalar).join(', ')}]`,
      '  # stop_on_exit: true   # devfleet을 끌 때 인프라도 함께 정지',
      '',
    );
  }
  lines.push('services:');
  const services = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  const ordered = waves(services, project.apps.map((a) => a.name)).flat();
  for (const name of ordered) {
    const app = services[name];
    lines.push(`  ${scalar(name)}:`);
    lines.push(`    dir: ${scalar(path.relative(project.root, app.runDir) || '.')}`);
    lines.push(`    cmd: ${scalar(app.cmd)}`);
    lines.push(`    port: ${app.port}`);
    if (app.dependsOn.length) lines.push(`    depends_on: [${app.dependsOn.map(scalar).join(', ')}]`);
    lines.push(app.health ? `    health: ${scalar(app.health)}` : '    # health: 미지정 시 포트가 열리면 준비된 것으로 봅니다');
    lines.push('');
  }
  if (!project.apps.length) lines.push('  # 찾은 Spring Boot 앱이 없습니다. 직접 추가하세요.', '');
  lines.push(
    '# 자주 함께 띄우는 서비스를 묶어 두면 `devfleet up core`처럼 쓸 수 있습니다.',
    '# groups:',
    `#   core: [${ordered.slice(0, 2).join(', ')}]`,
  );
  return `${lines.join('\n')}\n`;
}

function scalar(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./][A-Za-z0-9_./ :=-]*$/.test(text) && !/: |\s#|:$|\s$/.test(text) ? text : JSON.stringify(text);
}

function kebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function toPort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function trimSlash(value) {
  if (!value || value === '/') return '';
  return `/${value.replace(/^\/+|\/+$/g, '')}`;
}
