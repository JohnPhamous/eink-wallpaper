import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, ensureDirectory } from './fs.js';
import { paths } from './paths.js';
import type { CreativeBrief, EditionManifest } from './types.js';

interface AppState {
  schemaVersion: 1;
  latest?: EditionManifest;
  lastAttemptAt?: string;
  lastError?: string;
}

export async function loadState(): Promise<AppState> {
  try {
    return JSON.parse(await readFile(paths.state, 'utf8')) as AppState;
  } catch {
    return { schemaVersion: 1 };
  }
}

export async function saveState(state: AppState): Promise<void> {
  await atomicWrite(paths.state, `${JSON.stringify(state, null, 2)}\n`);
}

export function runDirectory(editionDate: string, runId: string): string {
  return path.join(paths.archives, editionDate, runId);
}

export async function saveManifest(manifest: EditionManifest): Promise<string> {
  const directory = runDirectory(manifest.editionDate, manifest.runId);
  await ensureDirectory(directory);
  const file = path.join(directory, 'manifest.json');
  await atomicWrite(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

async function manifestFiles(): Promise<string[]> {
  let dates: string[];
  try {
    dates = await readdir(paths.archives);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const date of dates) {
    const dateDirectory = path.join(paths.archives, date);
    let runs: string[];
    try {
      runs = await readdir(dateDirectory);
    } catch {
      continue;
    }
    files.push(...runs.map((run) => path.join(dateDirectory, run, 'manifest.json')));
  }
  return files;
}

export async function recentBriefs(days: number): Promise<Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }>> {
  const cutoff = Date.now() - days * 86_400_000;
  const output: Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }> = [];
  for (const file of await manifestFiles()) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8')) as EditionManifest;
      if (new Date(manifest.generatedAt).getTime() >= cutoff) {
        output.push({ generatedAt: manifest.generatedAt, brief: manifest.brief, rejected: Boolean(manifest.rejected) });
      }
    } catch {
      // Ignore a damaged historical run; it must not block today's edition.
    }
  }
  return output.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function manifestsForDate(date: string): Promise<EditionManifest[]> {
  const directory = path.join(paths.archives, date);
  let runs: string[];
  try {
    runs = await readdir(directory);
  } catch {
    return [];
  }
  const manifests: EditionManifest[] = [];
  for (const run of runs) {
    try {
      manifests.push(JSON.parse(await readFile(path.join(directory, run, 'manifest.json'), 'utf8')));
    } catch {
      // Ignore incomplete runs.
    }
  }
  return manifests.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function promoteLatest(manifest: EditionManifest): Promise<void> {
  const directory = runDirectory(manifest.editionDate, manifest.runId);
  const [bmp, preview, original] = await Promise.all([
    readFile(path.join(directory, manifest.bmpFile)),
    readFile(path.join(directory, manifest.previewFile)),
    readFile(path.join(directory, manifest.originalFile)),
  ]);
  await Promise.all([
    atomicWrite(path.join(paths.support, 'latest.bmp'), bmp),
    atomicWrite(path.join(paths.support, 'latest.png'), preview),
    atomicWrite(path.join(paths.support, 'latest-original.png'), original),
  ]);
  const state = await loadState();
  await saveState({ ...state, latest: manifest, lastAttemptAt: new Date().toISOString(), lastError: undefined });
}

export async function recordFailure(error: unknown): Promise<void> {
  const state = await loadState();
  await saveState({
    ...state,
    lastAttemptAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
  });
}
