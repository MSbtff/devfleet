import { isPortOpen } from './ports.js';

export const sleep = (ms, signal) =>
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

export async function checkOnce(health) {
  if (health.type === 'none') return true;
  if (health.type === 'tcp') return isPortOpen(health.port);
  try {
    const res = await fetch(health.url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    await res.body?.cancel();
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

/**
 * 헬스체크가 통과할 때까지 기다린다.
 * @returns {'healthy'|'exited'|'timeout'|'aborted'}
 */
export async function waitHealthy(health, { signal, alive = () => true, timeoutMs, intervalMs } = {}) {
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

export function describeHealth(health) {
  if (health.type === 'http') return health.url;
  if (health.type === 'tcp') return `tcp:${health.port}`;
  return '헬스체크 없음';
}
