import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { paths } from './paths.js';

export interface ImageReference {
  bytes: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const mediaTypes = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
] as const);

export async function loadMelloReferences(): Promise<ImageReference[]> {
  let names: string[];
  try {
    names = await readdir(paths.melloReferences);
  } catch {
    return [];
  }
  const selected = names
    .filter((name) => mediaTypes.has(path.extname(name).toLocaleLowerCase() as '.jpg'))
    .sort()
    .slice(0, 4);
  return Promise.all(selected.map(async (name) => {
    const extension = path.extname(name).toLocaleLowerCase() as '.jpg';
    return {
      bytes: await readFile(path.join(paths.melloReferences, name)),
      mediaType: mediaTypes.get(extension)!,
    };
  }));
}
