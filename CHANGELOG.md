# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/MSbtff/devfleet/releases/tag/v0.1.0
