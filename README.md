# devfleet

[![CI](https://github.com/MSbtff/devfleet/actions/workflows/ci.yml/badge.svg)](https://github.com/MSbtff/devfleet/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A CLI that starts many microservices locally **in dependency order**, **waits until each one is healthy**, and **collects all logs in one place**.

Running a Spring Boot microservice project locally usually looks like this:

- Open nine terminals, run `set -a; source .env`, then `./gradlew bootRun` in each one
- Services start before Eureka is up and fill the logs with registration errors
- You hit Ctrl+C, but a JVM survives, and the next run fails with `Port 7071 was already in use`
- You jump between terminals trying to find which service printed what

devfleet turns all of that into one command.

```bash
devfleet init        # analyze the project and generate devfleet.yaml
devfleet up          # infra (Docker) → Eureka → business services → Gateway
```

Output from a real 9-service project (all services ready in about 41 seconds):

```
devfleet              │ ✔ infra ready in 0.1s
devfleet              │ ✔ eureka-server ready in 6.1s · http://127.0.0.1:8761
devfleet              │ account-service starting: ./gradlew bootRun  (AccountService)
devfleet              │ menus-service starting: ./gradlew bootRun  (MenusService)
...
devfleet              │ ✔ gateway-server ready in 5.1s · http://127.0.0.1:7070
devfleet              │
devfleet              │ SERVICE            STATUS   PORT  READY  PID
devfleet              │ eureka-server      ✔ ready  8761  6.1s   14719
devfleet              │ account-service    ✔ ready  7071  17.3s  14807
devfleet              │ menus-service      ✔ ready  7072  13.1s  14810
devfleet              │ disposals-service  ✔ ready  7077  6.1s   15066
devfleet              │ gateway-server     ✔ ready  7070  5.1s   15296
```

## Features

- **Project analysis with `init`**: finds Spring Boot apps (Gradle or Maven, single or multi-module) and fills in the port, Actuator health URL, and run command.
  Placeholders such as `${PORT:7071}` in `application.yml` are resolved against `.env`.
  If there is a `compose.yaml`, service order and required infrastructure (DB, Redis, Kafka, …) are taken from `depends_on`.
- **Spring Cloud awareness**: apps that use Config Server, Eureka, Consul, or Nacos are started after that server.
  If the server is an app in the same project, devfleet depends on it; if it is an external product, devfleet finds it in `compose.yaml` and adds it to infra, or warns when it cannot.
  Mutual setups — Config Server registers with Eureka while Eureka reads its config from Config Server — are ordered Config → Eureka without creating a cycle.
- **Dependency order + health waiting**: a service starts only *after* its dependencies are ready. Services at the same level start in parallel.
- **Infra readiness that understands init containers**: Compose services count as ready when they are running and healthy, or when a one-shot init container exits with code 0.
- **Failure propagation**: when a service dies during startup, devfleet shows its last log lines and skips every service that depends on it.
- **Port conflict reporting**: tells you which PID holds a port. A healthy service that is already running (for example, one you are debugging in your IDE) is reused as-is.
- **Clean shutdown**: one Ctrl+C stops everything in reverse order (Gateway → business services → Eureka). Processes outside the process group, such as JVMs forked by the Gradle daemon, are found by port and stopped too.
- **Unified logs**: every line is prefixed with a colored service name, and each service also gets `.devfleet/logs/<service>.log`.

## Installation

Requires Node.js 20 or later.

```bash
git clone https://github.com/MSbtff/devfleet.git && cd devfleet
npm install         # also builds the TypeScript sources into dist/
npm link            # makes the devfleet command available everywhere
```

## Usage

| Command | Description |
|---|---|
| `devfleet init` | Analyze the current folder and create `devfleet.yaml` (`--print`: print instead of writing, `--force`: overwrite) |
| `devfleet up [name...]` | Start services or groups together with their dependencies. Starts everything when no name is given |
| `devfleet status` | Port and health status of each service, plus the process holding the port |
| `devfleet logs <name> [-f]` | Show a service's log file |
| `devfleet down` | Stop the infra containers (data volumes are kept) |

Options for `up`

| Option | Description |
|---|---|
| `--no-deps` | Don't start dependencies; only check that they are already running |
| `--no-infra` | Leave Docker Compose infrastructure alone |
| `--down` | Stop the infra containers on exit as well |
| `--only a,b` | Show only these services' logs on screen (all logs are still written to files) |
| `-q`, `--quiet` | Show only status messages on screen |
| `--dry-run` | Print the start plan without running anything |

Common patterns

```bash
devfleet up account-service            # just Eureka + Account (dependencies included automatically)
devfleet up gateway-server -q          # start everything, keep the screen quiet
devfleet up --only account-service     # start everything, watch only Account's logs
devfleet up account-service --no-deps  # Eureka is already running in your IDE debugger
```

## Configuration (`devfleet.yaml`)

```yaml
env_file: .env                 # environment variables injected into every service
env:                           # extra variables (take precedence over env_file)
  SPRING_PROFILES_ACTIVE: local

infra:                         # services started with `docker compose up -d` before the apps
  compose_file: compose.yaml   # for several files: compose_files: [a.yaml, b.yaml]
  services: [mariadb, redis, kafka]
  stop_on_exit: false
  timeout: 180                 # seconds to wait until containers are healthy (or init containers exit 0)

services:
  eureka-server:
    dir: eurekaServer          # working directory, relative to this file
    cmd: ./gradlew bootRun     # shell command
    port: 8761                 # used for port-conflict checks and shutdown cleanup
    health: http://127.0.0.1:8761/actuator/health

  account-service:
    dir: AccountService
    cmd: ./gradlew bootRun
    port: 7071
    depends_on: [eureka-server]
    env_file: AccountService/.env.local   # optional per-service env file
    health:
      http: http://127.0.0.1:7071/actuator/health
      timeout: 300             # seconds, default 180
    stop_timeout: 20           # seconds to wait after Ctrl+C, default 15

groups:
  core: [eureka-server, account-service]
```

When `health` is omitted, the service is ready as soon as `port` accepts connections. With `health: none` it is ready right after it starts.
HTTP health checks treat 2xx and 3xx responses as healthy. Spring Actuator returns 503 while a dependency such as the DB is DOWN, so devfleet waits until the service is actually usable.

### Notes for Gradle `bootRun`

- **The health timeout includes compile time.** On a cold start (no Gradle daemon, nothing compiled yet) every service starts its own daemon and compiles before the app boots. In the 9-service project above, the slowest service took about 20 seconds from a cold start, well within the 180-second default. Raise `health.timeout` for large modules.
- **Each `bootRun` keeps a Gradle daemon busy.** A running `bootRun` occupies its daemon, so N services mean N daemons in addition to N application JVMs. In the same project this came to about 3.3 GB for the daemons and 3.1 GB for the apps and wrapper clients. If memory is tight, start only what you need (`devfleet up account-service`), or run the remaining services as Compose containers. Run `./gradlew --stop` afterwards to release the daemons.

## Example

Try it without Spring:

```bash
cd examples/demo
node ../../dist/cli.js up
```

## Development

devfleet is written in TypeScript. Tests and the demo's fake services run directly through Node's type stripping, without a build step, so development requires **Node.js 22.18 or later**.

```bash
npm run typecheck   # type-check src and test
npm test            # run the .ts tests with node --test
npm run build       # produce dist/
```

| File | Responsibility |
|---|---|
| `src/cli.ts` | Commands and output |
| `src/args.ts` | Argument parsing |
| `src/config.ts` | Reading and validating `devfleet.yaml` and `.env` |
| `src/graph.ts` | Target resolution, cycle detection, start waves |
| `src/runner.ts` | Process launch, health waiting, shutdown cleanup |
| `src/infra.ts` | Docker Compose infra startup and readiness |
| `src/init.ts` | Spring Boot and Compose project analysis |
| `src/detectors.ts` | Spring Cloud server detection rules (Config, Eureka, Consul, Nacos) |
| `src/health.ts`, `src/ports.ts` | Health checks and port ownership |
| `src/logger.ts` | Colored, prefixed logs and log files |

### Adding a detection rule

Add one object to `RULES` in `src/detectors.ts` and `init` will recognize a new component.

```ts
{
  id: 'zookeeper',
  label: 'Zookeeper',
  infraImage: /zookeeper/,                                   // find the server by compose service name or image
  uses: (app) => /spring-cloud-starter-zookeeper/.test(app.buildText),
}
```

If the server is a Spring Boot app in the same project, add `serves: (app) => ...` so the server app can be recognized.
Rules are applied in array order, and a dependency that would create a cycle with an earlier rule is not added.

## Roadmap

- [ ] Detect Node, Python, and Go services (`package.json`, `pyproject.toml`, `go.mod`)
- [ ] Jar mode: build once with `bootJar` and run `java -jar`, so Gradle daemons don't stay resident per service
- [ ] `devfleet restart <name>` to restart one running service from another terminal
- [ ] Restart a service when its files change (`--watch`)
- [ ] Hybrid mode: run most services as Compose containers and only the ones you are editing locally
- [ ] Verify Windows support

## License

MIT
