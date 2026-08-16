import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

export async function atomicWrite(file: string, contents: string | Buffer, mode = 0o600): Promise<void> {
  await ensureDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, contents, { mode });
  await rename(temporary, file);
}
