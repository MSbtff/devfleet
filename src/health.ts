import { isPortOpen } from './ports.ts';
import type { Health } from './types.ts';

export type WaitResult = 'healthy' | 'exited' | 'timeout' | 'aborted';

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function checkOnce(health: Health): Promise<boolean> {
  switch (health.type) {
    case 'none':
      return true;
    case 'tcp':
      return isPortOpen(health.port);
    case 'http':
      try {
        const res = await fetch(health.url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
        await res.body?.cancel();
        return res.status >= 200 && res.status < 400;
      } catch {
        return false;
      }
  }
}

export interface WaitOptions {
  signal?: AbortSignal;
  /** Returning false means the process died, so waiting stops */
  alive?: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
}

/** Waits until the health check passes. */
export async function waitHealthy(
  health: Health,
  { signal, alive = () => true, timeoutMs, intervalMs }: WaitOptions = {},
): Promise<WaitResult> {
  const deadline = Date.now() + (timeoutMs ?? health.timeout * 1000);
  const interval = intervalMs ?? health.interval * 1000;
  if (health.type === 'none') {
    await sleep(Math.min(interval, 500), signal);
    if (signal?.aborted) return 'aborted';
    return alive() ? 'healthy' : 'exited';
  }
  for (;;) {
    if (signal?.aborted) return 'aborted';
    if (!alive()) return 'exited';
    if (await checkOnce(health)) return alive() ? 'healthy' : 'exited';
    if (Date.now() >= deadline) return 'timeout';
    await sleep(interval, signal);
  }
}

export function describeHealth(health: Health): string {
  switch (health.type) {
    case 'http':
      return health.url;
    case 'tcp':
      return `tcp:${health.port}`;
    case 'none':
      return 'no health check';
  }
}
