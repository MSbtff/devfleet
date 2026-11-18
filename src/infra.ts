import { execFile } from 'node:child_process';
import { isRecord, type Infra } from './types.ts';

/**
 * Readiness of Docker Compose infrastructure.
 *
 * `docker compose up --wait` treats one-shot containers that exit 0 (such as DB init jobs) as
 * failures, so it is not used. Instead the state is read with `docker compose ps --all --format json`
 * and evaluated here.
 */

export interface ContainerState {
  service: string;
  /** running, exited, restarting, created, dead … */
  state: string;
  /** healthy, unhealthy, starting, or '' when there is no health check */
  health: string;
  exitCode: number;
}

export interface InfraVerdict {
  ready: boolean;
  failures: string[];
  waiting: string[];
}

export function composeArgs(infra: Infra, action: string, extra: readonly string[] = []): string[] {
  return ['compose', ...infra.composeFiles.flatMap((f) => ['-f', f]), action, ...extra, ...infra.services];
}

/** Depending on the compose version, output is a JSON array or one JSON object per line (NDJSON). Both are accepted. */
export function parseComposePs(output: string): ContainerState[] {
  const text = output.trim();
  if (!text) return [];
  const items: unknown[] = text.startsWith('[')
    ? (JSON.parse(text) as unknown[])
    : text
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  return items.filter(isRecord).map((item) => ({
    service: String(item.Service ?? ''),
    state: String(item.State ?? '').toLowerCase(),
    health: String(item.Health ?? '').toLowerCase(),
    exitCode: Number(item.ExitCode ?? 0),
  }));
}

export function evaluateInfra(containers: readonly ContainerState[], services: readonly string[]): InfraVerdict {
  const failures: string[] = [];
  const waiting: string[] = [];
  for (const service of services) {
    const mine = containers.filter((c) => c.service === service);
    if (!mine.length) {
      waiting.push(`${service} (no container)`);
      continue;
    }
    for (const c of mine) {
      if (c.state === 'exited' && c.exitCode === 0) continue; // one-shot container that exited successfully
      if (c.state === 'exited' || c.state === 'dead') failures.push(`${service}: exited (exit ${c.exitCode})`);
      else if (c.health === 'unhealthy') failures.push(`${service}: unhealthy`);
      else if (c.state === 'running' && (c.health === '' || c.health === 'healthy')) continue;
      else waiting.push(`${service} (${c.health ? `${c.state}, ${c.health}` : c.state})`);
    }
  }
  return { ready: !failures.length && !waiting.length, failures, waiting };
}

export function readInfraState(infra: Infra, cwd: string): Promise<ContainerState[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      composeArgs(infra, 'ps', ['--all', '--format', 'json']),
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim() || err.message));
        try {
          resolve(parseComposePs(stdout));
        } catch (parseError) {
          reject(parseError as Error);
        }
      },
    );
  });
}
