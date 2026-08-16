import { readFile } from 'node:fs/promises';
import type { AppConfig } from './types.js';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function baseUrl(host: string): string {
  return /^https?:\/\//i.test(host) ? host.replace(/\/$/, '') : `http://${host.replace(/\/$/, '')}`;
}

async function postBmp(config: AppConfig, host: string, bmp: Buffer): Promise<void> {
  const payload = Buffer.concat([Buffer.from([0x01]), bmp]);
  const response = await fetch(`${baseUrl(host)}${config.display.endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) },
    body: payload,
    signal: AbortSignal.timeout(config.display.timeoutMs),
  });
  const body = (await response.text()).trim();
  if (!response.ok || body !== 'Data verification successful') {
    throw new Error(`Display rejected upload (HTTP ${response.status}, response ${JSON.stringify(body)})`);
  }
}

async function reachable(config: AppConfig, host: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl(host)}/index.html`, {
      method: 'GET',
      signal: AbortSignal.timeout(config.display.timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function checkDisplay(config: AppConfig): Promise<{ host: string; reachable: boolean }> {
  const hosts = [...new Set([config.display.host, 'esp32-s3-photopainter.local'])];
  for (const host of hosts) {
    if (await reachable(config, host)) return { host, reachable: true };
  }
  return { host: config.display.host, reachable: false };
}

export async function uploadBmp(config: AppConfig, bmp: Buffer): Promise<{ host: string; verifiedAt: string }> {
  const hosts = [...new Set([config.display.host, 'esp32-s3-photopainter.local'])];
  let lastError: unknown;
  for (const host of hosts) {
    for (const delay of [0, 5_000, 15_000, 45_000]) {
      if (delay) await sleep(delay);
      try {
        await postBmp(config, host, bmp);
        // A successful POST has already triggered a slow panel refresh. Never repost it.
        await sleep(35_000);
        if (!(await reachable(config, host))) {
          throw new Error('Display accepted the image but was not reachable after its refresh window');
        }
        return { host, verifiedAt: new Date().toISOString() };
      } catch (error) {
        lastError = error;
        if (
          error instanceof Error &&
          (error.message.includes('accepted the image') || error.message.startsWith('Display rejected upload'))
        ) throw error;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Display upload failed');
}

export async function uploadBmpFile(config: AppConfig, file: string): Promise<{ host: string; verifiedAt: string }> {
  const bmp = await readFile(file);
  if (bmp.subarray(0, 2).toString('ascii') !== 'BM') throw new Error('Upload source is not a BMP file');
  if (bmp.readInt32LE(18) !== 800 || Math.abs(bmp.readInt32LE(22)) !== 480 || bmp.readUInt16LE(28) !== 24) {
    throw new Error('Upload source must be an 800×480, 24-bit BMP');
  }
  return uploadBmp(config, bmp);
}
