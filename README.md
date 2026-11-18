# devfleet

로컬에서 마이크로서비스 여러 개를 **의존성 순서대로** 띄우고, **헬스체크가 통과할 때까지 기다리고**, 로그를 **한 화면에 모아** 보는 CLI입니다.

Spring Boot MSA를 로컬에서 개발하면 보통 이렇게 됩니다.

- 터미널 9개를 열고 `set -a; source .env` 후 `./gradlew bootRun`을 하나씩 실행
- Eureka가 뜨기 전에 다른 서비스를 띄워서 등록 오류 로그가 쌓임
- Ctrl+C를 했는데 JVM이 남아 다음 실행 때 `Port 7071 was already in use`
- 어느 서비스 로그인지 몰라 터미널을 오가며 찾음

devfleet은 이 과정을 명령 하나로 줄입니다.

```bash
devfleet init        # 프로젝트를 분석해 devfleet.yaml 생성
devfleet up          # 인프라(Docker) → Eureka → 업무 서비스 → Gateway 순서로 실행
```

출력 예시:

```
devfleet      │ ✔ infra 준비 완료
devfleet      │ eureka-server 시작: ./gradlew bootRun  (eurekaServer)
devfleet      │ ✔ eureka-server 준비 완료 7.1s · http://127.0.0.1:8761
devfleet      │ account-service 시작: ./gradlew bootRun  (AccountService)
devfleet      │ menus-service 시작: ./gradlew bootRun  (MenusService)
account-service │ Started AccountServiceApplication in 6.2 seconds
...
devfleet      │ 서비스             상태    포트  준비   PID
devfleet      │ eureka-server      ✔ 준비  8761  7.1s   33178
devfleet      │ account-service    ✔ 준비  7071  12.4s  33190
```

## 특징

- **`init` 자동 분석**: Spring Boot 앱(Gradle·Maven, 단일·멀티 모듈)을 찾아 포트, Actuator 헬스 주소, 실행 명령을 채웁니다.
  `application.yml`의 `${PORT:7071}` 같은 플레이스홀더는 `.env` 값으로 해석합니다.
  `compose.yaml`이 있으면 `depends_on`에서 서비스 간 순서와 필요한 인프라(DB, Redis, Kafka 등)를 가져옵니다.
- **의존성 순서 + 헬스 대기**: 의존 서비스가 *준비된 뒤에* 시작합니다. 같은 단계의 서비스는 동시에 띄웁니다.
- **실패 전파**: 시작 중 죽은 서비스는 마지막 로그를 보여 주고, 그 서비스에 의존하는 서비스는 건너뜁니다.
- **포트 충돌 안내**: 포트를 누가 쓰는지 PID와 함께 알려 줍니다. 이미 떠 있는 정상 서비스(예: IDE에서 디버깅 중)는 그대로 재사용합니다.
- **확실한 종료**: Ctrl+C 한 번이면 역순(Gateway → 업무 서비스 → Eureka)으로 정리합니다. Gradle 데몬이 띄운 JVM처럼 프로세스 그룹 밖에 남은 프로세스도 포트 기준으로 찾아 종료합니다.
- **로그 모음**: 서비스별 색상 접두어로 한 화면에 보여 주고 `.devfleet/logs/<서비스>.log`에도 저장합니다.

## 설치

Node.js 20 이상이 필요합니다.

```bash
git clone https://github.com/MSbtff/devfleet.git && cd devfleet
npm install         # 설치하면서 TypeScript를 dist/로 빌드합니다
npm link            # 어디서나 devfleet 명령 사용
```

## 사용법

| 명령 | 설명 |
|---|---|
| `devfleet init` | 현재 폴더를 분석해 `devfleet.yaml` 생성 (`--print`: 파일 대신 화면 출력, `--force`: 덮어쓰기) |
| `devfleet up [이름...]` | 서비스나 그룹을 의존성과 함께 실행. 이름이 없으면 전체 |
| `devfleet status` | 각 서비스의 포트·헬스 상태와 점유 프로세스 |
| `devfleet logs <이름> [-f]` | 로그 파일 보기 |
| `devfleet down` | infra 컨테이너 정지 (데이터 볼륨은 유지) |

`up` 옵션

| 옵션 | 설명 |
|---|---|
| `--no-deps` | 의존 서비스는 띄우지 않고 이미 실행 중인지만 확인 |
| `--no-infra` | Docker Compose 인프라를 건드리지 않음 |
| `--down` | 종료할 때 인프라도 정지 |
| `--only a,b` | 화면에는 지정한 서비스 로그만 표시 (파일에는 전부 기록) |
| `-q`, `--quiet` | 화면에는 상태 메시지만 표시 |
| `--dry-run` | 실행 계획만 출력 |

자주 쓰는 패턴

```bash
devfleet up account-service            # Eureka + Account만 (의존성 자동 포함)
devfleet up gateway-server -q          # 전체를 띄우되 화면은 조용히
devfleet up --only account-service     # 다 띄우고 Account 로그만 보기
devfleet up account-service --no-deps  # Eureka는 IDE에서 디버깅 중일 때
```

## 설정 파일 (`devfleet.yaml`)

```yaml
env_file: .env                 # 모든 서비스에 주입할 환경변수 파일
env:                           # 추가 환경변수 (env_file보다 우선)
  SPRING_PROFILES_ACTIVE: local

infra:                         # 앱보다 먼저 docker compose up -d 로 띄울 서비스
  compose_file: compose.yaml   # 여러 개면 compose_files: [a.yaml, b.yaml]
  services: [mariadb, redis, kafka]
  stop_on_exit: false
  timeout: 180                 # 컨테이너가 healthy(또는 초기화 컨테이너가 exit 0)가 될 때까지 기다릴 초

services:
  eureka-server:
    dir: eurekaServer          # 실행 폴더 (설정 파일 기준 상대 경로)
    cmd: ./gradlew bootRun     # 셸 명령
    port: 8761                 # 포트 충돌 검사·종료 정리에 사용
    health: http://127.0.0.1:8761/actuator/health

  account-service:
    dir: AccountService
    cmd: ./gradlew bootRun
    port: 7071
    depends_on: [eureka-server]
    env_file: AccountService/.env.local   # 서비스별 추가 env (선택)
    health:
      http: http://127.0.0.1:7071/actuator/health
      timeout: 300             # 초. 기본 180
    stop_timeout: 20           # Ctrl+C 후 기다릴 초. 기본 15

groups:
  core: [eureka-server, account-service]
```

`health`를 생략하면 `port`가 열리는 시점을 준비 완료로 봅니다. `health: none`이면 실행 직후 준비로 봅니다.
HTTP 헬스는 2xx·3xx 응답을 정상으로 봅니다. Spring Actuator는 DB 등이 DOWN이면 503을 돌려주므로, 실제로 쓸 수 있을 때까지 기다리게 됩니다.

## 예제

Spring 없이 바로 동작을 확인할 수 있습니다.

```bash
cd examples/demo
node ../../dist/cli.js up
```

## 개발

TypeScript로 작성했습니다. 테스트와 예제의 가짜 서비스는 Node의 TypeScript 실행 기능(type stripping)으로
빌드 없이 바로 돌아가므로 개발할 때는 **Node.js 22.18 이상**이 필요합니다.

```bash
npm run typecheck   # 타입 검사 (src + test)
npm test            # node --test로 .ts 테스트 실행
npm run build       # dist/ 생성
```

| 파일 | 역할 |
|---|---|
| `src/cli.ts` | 명령 파싱과 출력 |
| `src/config.ts` | `devfleet.yaml`·`.env` 읽기와 검증 |
| `src/graph.ts` | 대상 서비스 계산, 순환 검사, 실행 단계 나누기 |
| `src/runner.ts` | 프로세스 실행·헬스 대기·종료 정리 |
| `src/init.ts` | Spring Boot·Compose 프로젝트 분석 |
| `src/health.ts`, `src/ports.ts` | 헬스체크, 포트 점유 확인 |
| `src/logger.ts` | 색상 접두어 로그와 로그 파일 |

## 로드맵

- [ ] 일부는 Compose 컨테이너로, 수정 중인 서비스만 로컬로 띄우는 혼합 모드
- [ ] 파일 변경 시 해당 서비스만 재시작 (`--watch`)
- [ ] 실행 중인 서비스를 다른 터미널에서 재시작하는 `devfleet restart <이름>`
- [ ] Windows 지원 검증
- [ ] 영어 메시지

## 라이선스

MIT
