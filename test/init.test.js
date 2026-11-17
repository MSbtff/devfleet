import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { detectProject, renderConfig, resolvePlaceholders } from '../src/init.js';
import { normalizeConfig } from '../src/config.js';

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const BOOT = "plugins { id 'org.springframework.boot' version '3.5.0' }\n";
const ACTUATOR = "implementation 'org.springframework.boot:spring-boot-starter-actuator'\n";

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devfleet-init-'));
  write(root, '.env', 'ACCOUNT_SERVER_PORT=7171\n');
  // Eureka 서버: 자체 gradlew 보유
  write(root, 'eurekaServer/build.gradle', BOOT + ACTUATOR + "implementation 'spring-cloud-starter-netflix-eureka-server'\n");
  write(root, 'eurekaServer/gradlew', '');
  write(root, 'eurekaServer/src/main/resources/application.yaml', 'server:\n  port: "${EUREKA_PORT:8761}"\n');
  // Account: 자체 gradlew, .env로 포트 덮어씀, 별도 management 포트, 프로필 문서는 무시
  write(root, 'AccountService/build.gradle', BOOT + ACTUATOR + "implementation 'eureka-client'\n");
  write(root, 'AccountService/gradlew', '');
  write(
    root,
    'AccountService/src/main/resources/application.yml',
    'server:\n  port: "${ACCOUNT_SERVER_PORT:7071}"\nmanagement:\n  server:\n    port: 9071\n---\nspring:\n  config:\n    activate:\n      on-profile: docker\nserver:\n  port: 80\n',
  );
  // 멀티 모듈: 루트 gradlew를 쓰는 하위 프로젝트, properties 설정, actuator 없음
  write(root, 'gradlew', '');
  write(root, 'apps/menus/build.gradle.kts', 'plugins { id("org.springframework.boot") }\n');
  write(root, 'apps/menus/src/main/resources/application.properties', 'server.port=7072\nserver.servlet.context-path=/menus\n');
  // 앱이 아닌 공유 라이브러리
  write(root, 'shared/lib/build.gradle', BOOT);
  write(
    root,
    'compose.yaml',
    `services:
  mariadb: { image: mariadb:10.11 }
  database-init: { image: mariadb:10.11, depends_on: [mariadb] }
  redis: { image: redis:8 }
  grafana: { image: grafana/grafana }
  eureka-server: { build: { context: ., dockerfile: eurekaServer/Dockerfile } }
  account-service:
    build: { context: ., dockerfile: AccountService/Dockerfile }
    depends_on: { eureka-server: { condition: service_healthy }, database-init: {}, redis: {} }
`,
  );
  return root;
}

test('Spring Boot 앱, 포트, 헬스 주소, 실행 명령, 의존성, 인프라를 찾아낸다', () => {
  const root = makeProject();
  const project = detectProject(root, { useDocker: false });
  const apps = Object.fromEntries(project.apps.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(apps).sort(), ['account-service', 'eureka-server', 'menus']);

  assert.equal(apps['account-service'].port, 7171, '.env 값이 기본값보다 우선한다');
  assert.equal(apps['account-service'].health, 'http://127.0.0.1:9071/actuator/health');
  assert.deepEqual(apps['account-service'].dependsOn, ['eureka-server']);
  assert.equal(apps['account-service'].cmd, './gradlew bootRun');

  assert.equal(apps['eureka-server'].port, 8761);
  assert.equal(apps.menus.port, 7072);
  assert.equal(apps.menus.health, null);
  assert.equal(apps.menus.cmd, './gradlew :apps:menus:bootRun');
  assert.equal(apps.menus.runDir, root);

  assert.deepEqual(project.infra, ['mariadb', 'database-init', 'redis'], 'grafana처럼 앱이 의존하지 않는 컨테이너는 제외');
  assert.equal(project.envFile, '.env');
});

test('생성한 설정은 오류 없이 다시 읽힌다', () => {
  const root = makeProject();
  const text = renderConfig(detectProject(root, { useDocker: false }));
  const config = normalizeConfig(YAML.parse(text), root);
  assert.deepEqual(config.errors, []);
  assert.equal(config.services['account-service'].dir, path.join(root, 'AccountService'));
  assert.deepEqual(config.infra.services, ['mariadb', 'database-init', 'redis']);
  assert.ok(text.indexOf('eureka-server:') < text.indexOf('account-service:'), '의존성 순서로 정렬');
});

test('Spring 플레이스홀더를 해석한다', () => {
  assert.equal(resolvePlaceholders('${A:1}', {}), '1');
  assert.equal(resolvePlaceholders('${A:1}', { A: '2' }), '2');
  assert.equal(resolvePlaceholders('http://${HOST:localhost}:${PORT}', { PORT: '9' }), 'http://localhost:9');
});
