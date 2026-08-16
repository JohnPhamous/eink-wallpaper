import { editionManifestsBefore, loadEditionManifest } from './archive.js';
import { shiftDateKey } from './time.js';
import type { AppConfig, CreativeBrief, EditionManifest, NarrativeContext, StoryMemory, WorldLocationKey } from './types.js';

function memoryFrom(manifest: EditionManifest): StoryMemory {
  const story = manifest.brief.story;
  return {
    sourceDate: manifest.editionDate,
    title: manifest.brief.title,
    setting: manifest.brief.setting,
    metaphor: manifest.brief.metaphor,
    eventCues: manifest.brief.eventCues ?? [],
    worldLocationKey: story?.worldLocationKey,
    worldLocationDescription: story?.worldLocationDescription,
    narrativeBeat: story?.narrativeBeat,
    carriedMotifs: story?.carriedMotifs?.length
      ? story.carriedMotifs
      : [manifest.brief.conceptKey, manifest.brief.metaphor].filter(Boolean),
  };
}

function previousYearDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const candidate = new Date(Date.UTC(year - 1, month - 1, day));
  if (candidate.getUTCMonth() === month - 1) return candidate.toISOString().slice(0, 10);
  return new Date(Date.UTC(year - 1, month, 0)).toISOString().slice(0, 10);
}

function isSunday(date: string): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
}

function locationHistory(manifests: EditionManifest[]): NarrativeContext['locationHistory'] {
  const locations = new Map<WorldLocationKey, NarrativeContext['locationHistory'][number]>();
  for (const manifest of manifests) {
    const story = manifest.brief.story;
    if (!story) continue;
    const existing = locations.get(story.worldLocationKey);
    locations.set(story.worldLocationKey, {
      key: story.worldLocationKey,
      description: story.worldLocationDescription,
      appearances: (existing?.appearances ?? 0) + 1,
      lastUsed: manifest.editionDate,
    });
  }
  return [...locations.values()].sort((a, b) => b.lastUsed.localeCompare(a.lastUsed));
}

function recentMotifs(manifests: EditionManifest[]): NarrativeContext['recentMotifs'] {
  return manifests.slice(-14).reverse().map((manifest) => {
    const brief: CreativeBrief = manifest.brief;
    const story = brief.story;
    return {
      sourceDate: manifest.editionDate,
      motifs: story?.carriedMotifs?.length
        ? story.carriedMotifs
        : [brief.conceptKey, brief.metaphor].filter(Boolean),
    };
  });
}

export async function buildNarrativeContext(config: AppConfig, editionDate: string): Promise<NarrativeContext> {
  const priorYear = await editionManifestsBefore(editionDate, 370);
  const previousChapter = priorYear.findLast((manifest) => manifest.editionDate < editionDate);
  const monday = shiftDateKey(editionDate, -6);
  const weekly = isSunday(editionDate)
    ? priorYear.filter((manifest) => manifest.editionDate >= monday && manifest.editionDate < editionDate)
    : [];
  const anniversaryManifest = await loadEditionManifest(previousYearDate(editionDate));
  return {
    editionKind: isSunday(editionDate) ? 'sunday-tapestry' : 'daily-chapter',
    previousChapter: previousChapter ? memoryFrom(previousChapter) : undefined,
    locationHistory: locationHistory(priorYear),
    recentMotifs: recentMotifs(priorYear),
    weeklyMemories: weekly.map(memoryFrom),
    anniversary: anniversaryManifest ? memoryFrom(anniversaryManifest) : undefined,
  };
}
