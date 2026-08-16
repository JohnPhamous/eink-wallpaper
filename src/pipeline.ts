import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hash } from './hash.js';
import { fetchTodayEvents } from './calendar.js';
import { fetchWeather } from './weather.js';
import { createBrief, generateArtwork, inspectArtwork } from './ai.js';
import { loadState, promoteLatest, recentBriefs, recordFailure, runDirectory, saveManifest, saveState } from './archive.js';
import { renderArtwork } from './render.js';
import { uploadBmp } from './display.js';
import { log, pruneLogs } from './logger.js';
import { midnightUtc, todayBounds } from './time.js';
import type { AppConfig, EditionManifest, RunOptions } from './types.js';

function notifyFailure(): void {
  const script = 'display notification "Daily e-ink update failed. Run eink-wallpaper status." with title "Eink Wallpaper"';
  spawn('/usr/bin/osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
}

export async function runPipeline(config: AppConfig, options: RunOptions): Promise<EditionManifest | undefined> {
  const editionNow = options.date
    ? new Date(midnightUtc(options.date, config.timezone).getTime() + 12 * 60 * 60 * 1000)
    : new Date();
  const editionDate = todayBounds(config.timezone, editionNow).date;
  const state = await loadState();
  if (!options.force && options.mode === 'daily' && state.latest?.editionDate === editionDate && state.latest.uploadVerified) {
    await log('info', 'daily_edition_unchanged', { editionDate, runId: state.latest.runId });
    return undefined;
  }

  const startedAt = Date.now();
  await log('info', 'run_started', { editionDate, mode: options.mode, upload: options.upload });
  try {
    await pruneLogs();
    const [events, weather, history] = await Promise.all([
      fetchTodayEvents(config, editionNow),
      fetchWeather(config, editionDate),
      recentBriefs(config.art.conceptMemoryDays),
    ]);
    const inputHash = hash({
      events: events.map((event) => ({ ...event, notes: event.notes ? hash(event.notes) : undefined })),
      weather,
    }, 32);
    const priorBrief = options.mode === 'regenerate' && state.latest?.editionDate === editionDate
      ? state.latest.brief
      : undefined;
    const brief = priorBrief ?? await createBrief(config, editionDate, events, weather, history, options.newConcept);
    let correction: string | undefined;
    let finalManifest: EditionManifest | undefined;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const runId = `${Date.now()}-${randomUUID().slice(0, 8)}-a${attempt}`;
      const directory = runDirectory(editionDate, runId);
      const artwork = await generateArtwork(config, brief, correction);
      const rendered = await renderArtwork(artwork.bytes, directory);
      const qa = await inspectArtwork(config, rendered.original, rendered.preview, undefined, brief);
      const manifest: EditionManifest = {
        schemaVersion: 1,
        editionDate,
        runId,
        generatedAt: new Date().toISOString(),
        inputHash,
        mode: options.mode,
        model: config.models.image,
        brief,
        qa,
        originalFile: rendered.originalFile,
        previewFile: rendered.previewFile,
        bmpFile: rendered.bmpFile,
        rejected: !qa.pass,
      };
      await saveManifest(manifest);
      if (!qa.pass) {
        await log('warn', 'artwork_rejected', { editionDate, runId, attempt, reasonCount: qa.reasons.length });
        correction = qa.correction || qa.reasons.join('; ');
        if (attempt === 2) throw new Error('Both generated candidates failed visual QA; preserving the current display');
        continue;
      }

      if (options.upload) {
        const receipt = await uploadBmp(config, rendered.bmp);
        manifest.uploadedAt = receipt.verifiedAt;
        manifest.uploadVerified = true;
        await saveManifest(manifest);
        await promoteLatest(manifest);
      }
      finalManifest = manifest;
      break;
    }
    if (!finalManifest) throw new Error('No acceptable artwork was produced');
    if (!options.upload) {
      const currentState = await loadState();
      await saveState({
        ...currentState,
        lastAttemptAt: new Date().toISOString(),
        lastError: undefined,
      });
    }
    await log('info', 'run_completed', {
      editionDate,
      runId: finalManifest.runId,
      uploadVerified: finalManifest.uploadVerified ?? false,
      durationMs: Date.now() - startedAt,
      weatherProvider: weather.provider,
      eventCount: events.length,
    });
    return finalManifest;
  } catch (error) {
    await recordFailure(error);
    await log('error', 'run_failed', {
      editionDate,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function sendScheduledFailureNotification(): void {
  notifyFailure();
}
