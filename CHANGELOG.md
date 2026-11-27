# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `restart: on-failure` and `max_restarts` (top level or per service): a service that exits on its own after becoming ready is started again after 1s, 2s, 4s, … (at most 30s), up to `max_restarts` times in a row (default 3). A service that stayed up for a minute gets its full budget again.
- `devfleet stop` and `devfleet restart` cancel a pending automatic restart and take over.
- `devfleet status` shows how many times the running `devfleet up` restarted each service.
- Jar mode: `build`, `jar`, and `java_opts` per service. devfleet runs the build before starting the service, then runs a copy of the newest matching jar (skipping `*-plain.jar`) with `java -jar`, using `JAVA_HOME` when it is set. `build` also works on its own before any `cmd`, and takes `{ cmd, dir }` to build a module from the root project.
- Builds run one at a time by default (`build_concurrency`), so Gradle reuses one daemon. They start right away in dependency order, alongside the infra, and are cancelled when a dependency fails. A service that is already running is reused without building it.
- `devfleet init --jar` generates jar-mode settings for Gradle (`bootJar`) and Maven (`package`) apps, including multi-module projects, with `java_opts: -XX:TieredStopAtLevel=1`, which `bootRun` also uses.
- `devfleet restart` rebuilds services that have a `build` before stopping them, and leaves the running process alone when the build fails. `devfleet restart --no-build` and `devfleet up --no-build` skip builds.
- Once no build is running or waiting, devfleet stops the Gradle daemons its builds used instead of leaving them idle in memory for three hours. Builds use their own daemon registry under `.devfleet/gradle-daemons`, so daemons used by an IDE or a `bootRun` service are not touched. `gradle_daemon: keep` turns this off.
- The jar copy in `.devfleet/jars` is a copy-on-write clone where the file system supports it (APFS, btrfs, XFS), so it takes no extra disk space.
- `devfleet up` warns when many jar services run without a heap limit for the machine's memory, since each JVM may otherwise grow to a quarter of it.

## [0.2.0] - 2026-11-20

### Added

- `devfleet restart <name...>` and `devfleet stop <name...>`: restart or stop services and groups inside a running `devfleet up` from another terminal. Restarts stop dependents first and start in dependency order, and work on crashed, failed, or skipped services too.
- A local control socket that `devfleet up` listens on, so other commands can reach it.

### Changed

- `devfleet status` shows a FLEET column with what the running `devfleet up` knows about each service.
- `devfleet down` also stops a running `devfleet up` before stopping the infra containers, and no longer fails when no infra is configured but an `up` was stopped.
- `devfleet up` no longer exits while a service stopped with `devfleet stop` could still be restarted.

### Security

- The control socket moved from a predictable name in the shared temp folder to a per-user directory: `$XDG_RUNTIME_DIR/devfleet/` when set, otherwise `<tmpdir>/devfleet-<uid>/` with mode 700. Both `devfleet up` and the commands that connect to it refuse the directory if it is a symlink, is owned by another user, or is accessible to group or others, so another local user can no longer plant a socket that `restart`, `stop`, `status`, or `down` would talk to. The socket is set to mode 600, and a stale socket is only removed when it belongs to the current user.
- Text received over the control socket has control characters (C0 except tab, DEL, and C1) removed before it is printed, so it cannot inject ANSI/OSC escape sequences into the terminal. `devfleet up` rejects `restart` and `stop` requests whose names are not plain service names before logging them.

## [0.1.0] - 2026-11-18

First public release.

### Added

- `devfleet up`: start services in dependency order, wait for HTTP/TCP health checks, start independent services in parallel, and stop everything in reverse order on Ctrl+C.
- Graceful shutdown that escalates SIGINT → SIGTERM (after `stop_timeout`) → SIGKILL until the whole process group has exited, so nothing is left behind when the shell exits first (as dash does on Linux) or a service ignores signals. A second Ctrl+C forces an immediate stop.
- Docker Compose infra startup that treats one-shot init containers exiting with code 0 as ready.
- Failure propagation: a service that dies during startup shows its last log lines, and its dependents are skipped.
- Port conflict reporting with the owning PID, and reuse of an already-running healthy service.
- Cleanup of processes left outside the process group (such as JVMs forked by the Gradle daemon) by port.
- `devfleet init`: detect Spring Boot apps (Gradle/Maven, single and multi-module), ports, Actuator health URLs, `.env` placeholders, and Compose `depends_on`.
- Spring Cloud detection rules for Config Server, Eureka, Consul, and Nacos, with cycle-safe ordering.
- `devfleet status`, `devfleet logs`, `devfleet down`, groups, `--no-deps`, `--only`, `--quiet`, and `--dry-run`.
- English CLI messages, help text, and generated `devfleet.yaml` comments.
- End-to-end tests for the CLI and the stop, crash, and health-timeout paths, run on Linux and macOS with Node 22 and 24, plus a Node 20 runtime check of the packed tarball.

[Unreleased]: https://github.com/MSbtff/devfleet/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MSbtff/devfleet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MSbtff/devfleet/releases/tag/v0.1.0
