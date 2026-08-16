import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite } from './fs.js';
import { paths } from './paths.js';
import type { AppConfig } from './types.js';

const configSchema = z.object({
  schemaVersion: z.literal(1),
  timezone: z.literal('America/Los_Angeles'),
  display: z.object({
    host: z.string().min(1),
    endpoint: z.literal('/dataUP'),
    timeoutMs: z.number().int().positive(),
  }),
  calendar: z.object({
    provider: z.enum(['eventkit', 'google']),
    clientId: z.string().min(1).optional(),
    accounts: z.array(z.enum(['work', 'personal'])).min(1),
    excludedCalendarNames: z.array(z.string().min(1)),
    excludedEventTitlePrefixes: z.array(z.string().min(1)).default([]),
    workSourceMatchers: z.array(z.string().min(1)),
  }),
  weather: z.object({
    latitude: z.number(),
    longitude: z.number(),
    userAgent: z.string().min(1),
  }),
  models: z.object({
    brief: z.string().min(1),
    image: z.string().min(1),
    qa: z.string().min(1),
    imageSize: z.enum(['1K', '2K']),
  }),
  schedule: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  art: z.object({
    collarColor: z.literal('cobalt blue'),
    conceptMemoryDays: z.number().int().positive(),
    gymAnchorCooldownDays: z.number().int().positive(),
    recurringWorkCooldownDays: z.number().int().positive(),
  }),
});

export function defaultConfig(
  clientId: string | undefined,
  displayHost: string,
  weatherContact: string,
  latitude: number,
  longitude: number,
  excludedCalendarNames: string[],
  excludedEventTitlePrefixes: string[],
  workSourceMatchers: string[],
): AppConfig {
  return {
    schemaVersion: 1,
    timezone: 'America/Los_Angeles',
    display: { host: displayHost, endpoint: '/dataUP', timeoutMs: 20_000 },
    calendar: {
      provider: 'eventkit',
      ...(clientId ? { clientId } : {}),
      accounts: ['work', 'personal'],
      excludedCalendarNames,
      excludedEventTitlePrefixes,
      workSourceMatchers,
    },
    weather: {
      latitude,
      longitude,
      userAgent: `eink-wallpaper/0.1 (${weatherContact})`,
    },
    models: {
      brief: 'google/gemini-3-flash',
      image: 'google/gemini-3.1-flash-image',
      qa: 'google/gemini-3-flash',
      imageSize: '1K',
    },
    schedule: { hour: 5, minute: 30 },
    art: {
      collarColor: 'cobalt blue',
      conceptMemoryDays: 30,
      gymAnchorCooldownDays: 7,
      recurringWorkCooldownDays: 30,
    },
  };
}

export async function loadConfig(): Promise<AppConfig> {
  let raw: string;
  try {
    raw = await readFile(paths.config, 'utf8');
  } catch {
    throw new Error(`Not configured. Run: eink-wallpaper setup`);
  }
  return configSchema.parse(JSON.parse(raw)) as AppConfig;
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const valid = configSchema.parse(config);
  await atomicWrite(paths.config, `${JSON.stringify(valid, null, 2)}\n`);
}
