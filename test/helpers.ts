import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/config.ts';
import type { Config } from '../src/types.ts';

export const FAKE = fileURLToPath(new URL('./fixtures/fake-service.ts', import.meta.url));
export const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

export const fake = (flags: string): string =>
  `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} ${flags}`;

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export function tempDir(prefix = 'devfleet-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface Setup {
  config: Config;
  out: PassThrough;
  output: () => string;
  root: string;
}

export function setup(raw: Record<string, unknown>, root: string = tempDir()): Setup {
  const config = normalizeConfig(raw, root);
  assert.deepEqual(config.errors, []);
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk) => (text += chunk));
  return { config, out, output: () => text, root };
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
