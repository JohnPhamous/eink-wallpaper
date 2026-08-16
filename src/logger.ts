import { appendFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensureDirectory } from './fs.js';
import { paths } from './paths.js';

type LogLevel = 'info' | 'warn' | 'error';

export async function log(level: LogLevel, event: string, data: Record<string, unknown> = {}): Promise<void> {
  await ensureDirectory(paths.logs);
  const day = new Date().toISOString().slice(0, 10);
  const record = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...data });
  await appendFile(path.join(paths.logs, `${day}.jsonl`), `${record}\n`, { mode: 0o600 });
}

export async function pruneLogs(retentionDays = 30): Promise<void> {
  await ensureDirectory(paths.logs);
  const cutoff = Date.now() - retentionDays * 86_400_000;
  for (const name of await readdir(paths.logs)) {
    const file = path.join(paths.logs, name);
    if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
  }
}
