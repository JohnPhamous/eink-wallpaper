import { readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, ensureDirectory } from './fs.js';
import { paths } from './paths.js';
import { previewFromBmp } from './render.js';
import type { CreativeBrief, EditionManifest } from './types.js';

interface AppState {
  schemaVersion: 1;
  latest?: EditionManifest;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface StoredEdition {
  manifest: EditionManifest;
  png: Buffer;
  bmp: Buffer;
}

interface LegacyManifestFields {
  originalFile?: string;
  previewFile?: string;
  bmpFile?: string;
}

interface LegacyManifest extends Omit<EditionManifest, 'schemaVersion'>, Required<LegacyManifestFields> {
  schemaVersion: 1;
}

interface StoredPaths {
  directory: string;
  png: string;
  bmp: string;
  manifest: string;
}

function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid edition date: ${date}`);
}

function namedFiles(directory: string, date: string): StoredPaths {
  assertDate(date);
  return {
    directory,
    png: path.join(directory, `${date}.png`),
    bmp: path.join(directory, `${date}.bmp`),
    manifest: path.join(directory, `${date}.json`),
  };
}

export function editionFiles(date: string): StoredPaths {
  return namedFiles(path.join(paths.editions, date.slice(0, 4)), date);
}

export function candidateFiles(date: string): StoredPaths {
  return namedFiles(paths.candidates, date);
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

async function saveStored(files: StoredPaths, manifest: EditionManifest, png: Buffer, bmp: Buffer): Promise<void> {
  await ensureDirectory(files.directory);
  await Promise.all([
    atomicWrite(files.png, png),
    atomicWrite(files.bmp, bmp),
    atomicWrite(files.manifest, `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
}

async function loadStored(files: StoredPaths): Promise<StoredEdition | undefined> {
  try {
    const [rawManifest, png, bmp] = await Promise.all([
      readFile(files.manifest, 'utf8'),
      readFile(files.png),
      readFile(files.bmp),
    ]);
    return { manifest: JSON.parse(rawManifest) as EditionManifest, png, bmp };
  } catch {
    return undefined;
  }
}

export async function saveCandidate(manifest: EditionManifest, png: Buffer, bmp: Buffer): Promise<void> {
  await saveStored(candidateFiles(manifest.editionDate), manifest, png, bmp);
}

export async function saveEdition(manifest: EditionManifest, png: Buffer, bmp: Buffer): Promise<void> {
  await saveStored(editionFiles(manifest.editionDate), manifest, png, bmp);
}

export async function loadCandidate(date: string): Promise<StoredEdition | undefined> {
  return loadStored(candidateFiles(date));
}

export async function removeCandidate(date: string): Promise<void> {
  const files = candidateFiles(date);
  await Promise.all([files.png, files.bmp, files.manifest].map(async (file) => {
    try {
      await unlink(file);
    } catch {
      // Missing candidate files are already clean.
    }
  }));
}

export async function loadEdition(date: string): Promise<StoredEdition | undefined> {
  return loadStored(editionFiles(date));
}

export async function loadEditionManifest(date: string): Promise<EditionManifest | undefined> {
  try {
    return JSON.parse(await readFile(editionFiles(date).manifest, 'utf8')) as EditionManifest;
  } catch {
    return undefined;
  }
}

async function editionManifestFiles(): Promise<string[]> {
  let years: string[];
  try {
    years = await readdir(paths.editions);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const year of years.filter((entry) => /^\d{4}$/.test(entry))) {
    const directory = path.join(paths.editions, year);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      continue;
    }
    files.push(...entries.filter((entry) => /^\d{4}-\d{2}-\d{2}\.json$/.test(entry)).map((entry) => path.join(directory, entry)));
  }
  return files;
}

export async function recentBriefs(days: number): Promise<Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }>> {
  const cutoff = Date.now() - days * 86_400_000;
  const output: Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }> = [];
  for (const file of await editionManifestFiles()) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8')) as EditionManifest;
      if (new Date(manifest.generatedAt).getTime() >= cutoff) {
        output.push({ generatedAt: manifest.generatedAt, brief: manifest.brief, rejected: false });
      }
    } catch {
      // A damaged historical edition must not block today's edition.
    }
  }
  return output.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
}

export async function editionManifestsBefore(date: string, days: number): Promise<EditionManifest[]> {
  const earliest = new Date(`${date}T12:00:00Z`);
  earliest.setUTCDate(earliest.getUTCDate() - days);
  const earliestDate = earliest.toISOString().slice(0, 10);
  const output: EditionManifest[] = [];
  for (const file of await editionManifestFiles()) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8')) as EditionManifest;
      if (manifest.editionDate >= earliestDate && manifest.editionDate < date && !manifest.rejected) output.push(manifest);
    } catch {
      // Story continuity is best effort; one damaged edition must not block today.
    }
  }
  return output.sort((a, b) => a.editionDate.localeCompare(b.editionDate));
}

export async function promoteLatest(manifest: EditionManifest, png: Buffer, bmp: Buffer): Promise<void> {
  await saveEdition(manifest, png, bmp);
  await Promise.all([
    atomicWrite(path.join(paths.support, 'latest.png'), png),
    atomicWrite(path.join(paths.support, 'latest.bmp'), bmp),
    removeCandidate(manifest.editionDate),
  ]);
  const state = await loadState();
  await saveState({ ...state, latest: manifest, lastAttemptAt: new Date().toISOString(), lastError: undefined });
}

function modernManifest(legacy: LegacyManifest | (EditionManifest & LegacyManifestFields)): EditionManifest {
  return {
    schemaVersion: 2,
    editionDate: legacy.editionDate,
    runId: legacy.runId,
    generatedAt: legacy.generatedAt,
    inputHash: legacy.inputHash,
    mode: legacy.mode,
    model: legacy.model,
    brief: legacy.brief,
    qa: legacy.qa,
    uploadedAt: legacy.uploadedAt,
    uploadVerified: legacy.uploadVerified,
    rejected: false,
  };
}

async function migrateLegacyEditions(): Promise<string[]> {
  let dates: string[];
  try {
    dates = await readdir(paths.archives);
  } catch {
    return [];
  }
  const migrated: string[] = [];
  for (const date of dates.filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry))) {
    const dateDirectory = path.join(paths.archives, date);
    let runs: string[];
    try {
      runs = await readdir(dateDirectory);
    } catch {
      continue;
    }
    const candidates: Array<{ directory: string; manifest: LegacyManifest }> = [];
    for (const run of runs) {
      const directory = path.join(dateDirectory, run);
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as LegacyManifest;
        if (manifest.qa.pass && !manifest.rejected && manifest.previewFile && manifest.bmpFile) candidates.push({ directory, manifest });
      } catch {
        // Incomplete and rejected legacy attempts are not daily editions.
      }
    }
    candidates.sort((a, b) => Number(Boolean(b.manifest.uploadVerified)) - Number(Boolean(a.manifest.uploadVerified)) || b.manifest.generatedAt.localeCompare(a.manifest.generatedAt));
    for (const candidate of candidates) {
      try {
        const bmp = await readFile(path.join(candidate.directory, candidate.manifest.bmpFile));
        const png = await previewFromBmp(bmp);
        await saveStored(editionFiles(date), modernManifest(candidate.manifest), png, bmp);
        migrated.push(date);
        break;
      } catch {
        // Try the next accepted candidate if one legacy directory is damaged.
      }
    }
  }
  return migrated.sort();
}

async function pruneFullColorFiles(directory: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      removed += await pruneFullColorFiles(file);
    } else if (entry.name === 'original.png' || entry.name === 'originals-contact-sheet.png' || entry.name === 'latest-original.png') {
      await unlink(file);
      removed += 1;
    }
  }
  return removed;
}

export async function migrateLegacyStorage(): Promise<{ editionDate?: string; migratedDates: string[]; removedFullColorFiles: number }> {
  const state = await loadState();
  const migratedDates = await migrateLegacyEditions();
  let editionDate: string | undefined;
  if (state.latest?.uploadVerified) {
    const [png, bmp] = await Promise.all([
      readFile(path.join(paths.support, 'latest.png')),
      readFile(path.join(paths.support, 'latest.bmp')),
    ]);
    const legacy = state.latest as EditionManifest & LegacyManifestFields;
    const manifest = { ...modernManifest(legacy), uploadVerified: true };
    await promoteLatest(manifest, png, bmp);
    editionDate = manifest.editionDate;
  }
  const removedFullColorFiles = await pruneFullColorFiles(paths.support);
  return { editionDate, migratedDates, removedFullColorFiles };
}

export async function recordFailure(error: unknown): Promise<void> {
  const state = await loadState();
  await saveState({
    ...state,
    lastAttemptAt: new Date().toISOString(),
    lastError: error instanceof Error ? error.message : String(error),
  });
}
