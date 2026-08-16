#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Command } from 'commander';
import { authorizeCalendar, authorizeLocalCalendar, fetchTodayEvents } from './calendar.js';
import { defaultConfig, loadConfig, saveConfig } from './config.js';
import { checkDisplay, uploadBmpFile } from './display.js';
import { getSecret, hasSecret, setSecret } from './keychain.js';
import { installLaunchAgent, kickstartLaunchAgent, uninstallLaunchAgent } from './launchd.js';
import { paths } from './paths.js';
import { loadCandidate, loadEdition, loadState, migrateLegacyStorage, promoteLatest } from './archive.js';
import { uploadBmp } from './display.js';
import { runPipeline, sendScheduledFailureNotification } from './pipeline.js';
import { fetchWeather } from './weather.js';
import { runBichonBakeoff } from './bakeoff.js';
import { rebuildStyleStudy, runStyleStudy } from './style-study.js';

const program = new Command();

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

function commaSeparated(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function coordinate(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return parsed;
}

async function readHidden(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
    };
    const onData = (character: string) => {
      if (character === '\u0003') {
        cleanup();
        reject(new Error('Cancelled'));
      } else if (character === '\r' || character === '\n') {
        cleanup();
        resolve(value);
      } else if (character === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += character;
      }
    };
    input.on('data', onData);
  });
}

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
  throw new Error('__handled__');
}

program
  .name('eink-wallpaper')
  .description('Generate and publish a text-free daily bichon artwork to a Waveshare PhotoPainter')
  .version('0.1.0');

program
  .command('setup')
  .description('Configure local Calendar access, weather, and the PhotoPainter address')
  .option('--calendar-provider <provider>', 'eventkit or google', 'eventkit')
  .option('--oauth-client <file>', 'Google desktop OAuth client JSON')
  .option('--display-host <host>', 'Reserved display IP or hostname')
  .option('--weather-contact <contact>', 'NWS User-Agent contact email or URL')
  .option('--weather-latitude <latitude>', 'Weather latitude; stored only in local config')
  .option('--weather-longitude <longitude>', 'Weather longitude; stored only in local config')
  .option('--exclude-calendars <names>', 'Comma-separated calendar names to ignore')
  .option('--exclude-event-prefixes <prefixes>', 'Comma-separated event-title prefixes to ignore')
  .option('--work-source-matchers <matchers>', 'Comma-separated EventKit source-name fragments treated as work')
  .action(async (options: {
    calendarProvider: string;
    oauthClient?: string;
    displayHost?: string;
    weatherContact?: string;
    weatherLatitude?: string;
    weatherLongitude?: string;
    excludeCalendars?: string;
    excludeEventPrefixes?: string;
    workSourceMatchers?: string;
  }) => {
    if (options.calendarProvider !== 'eventkit' && options.calendarProvider !== 'google') {
      throw new Error('--calendar-provider must be eventkit or google');
    }
    const displayHost = options.displayHost ?? await ask('PhotoPainter reserved IP or hostname: ');
    const weatherContact = options.weatherContact ?? await ask('Contact email or URL for the NWS User-Agent: ');
    const latitudeInput = options.weatherLatitude ?? await ask('Weather latitude: ');
    const longitudeInput = options.weatherLongitude ?? await ask('Weather longitude: ');
    if (!displayHost || !weatherContact || !latitudeInput || !longitudeInput) {
      throw new Error('Display host, NWS contact, and weather coordinates are required');
    }
    const latitude = coordinate(latitudeInput, 'Latitude', -90, 90);
    const longitude = coordinate(longitudeInput, 'Longitude', -180, 180);
    let clientId: string | undefined;
    if (options.calendarProvider === 'google') {
      const oauthFile = options.oauthClient ?? await ask('Path to Google desktop OAuth client JSON: ');
      const credentials = JSON.parse(await readFile(path.resolve(oauthFile), 'utf8')) as {
        installed?: { client_id?: string; client_secret?: string };
      };
      const client = credentials.installed;
      if (!client?.client_id || !client.client_secret) throw new Error('Expected a Google Desktop app OAuth client JSON');
      clientId = client.client_id;
      await setSecret('google-oauth-client-secret', client.client_secret);
    }
    const config = defaultConfig(
      clientId,
      displayHost,
      weatherContact,
      latitude,
      longitude,
      commaSeparated(options.excludeCalendars),
      commaSeparated(options.excludeEventPrefixes),
      commaSeparated(options.workSourceMatchers),
    );
    config.calendar.provider = options.calendarProvider;
    await saveConfig(config);
    const authorization = options.calendarProvider === 'eventkit' ? 'local' : 'all';
    output.write(`Configured ${paths.config}\nNext: eink-wallpaper set-gateway-key\nThen: eink-wallpaper authorize ${authorization}\n`);
  });

program
  .command('set-gateway-key')
  .description('Store the Vercel AI Gateway key in macOS Keychain; accepts hidden input or stdin')
  .action(async () => {
    const key = await readHidden('Vercel AI Gateway key: ');
    if (!key) throw new Error('Gateway key cannot be empty');
    await setSecret('vercel-ai-gateway-key', key);
    output.write('Gateway key stored in macOS Keychain.\n');
  });

program
  .command('authorize')
  .description('Authorize local EventKit or Google Calendar access')
  .argument('[account]', 'local, work, personal, or all', 'local')
  .action(async (account: string) => {
    const config = await loadConfig();
    if (account === 'local') {
      await authorizeLocalCalendar();
      output.write('Authorized local Calendar access.\n');
      return;
    }
    if (config.calendar.provider !== 'google') throw new Error('Google authorization is disabled; use: eink-wallpaper authorize local');
    const accounts = account === 'all' ? config.calendar.accounts : [account];
    for (const candidate of accounts) {
      if (candidate !== 'work' && candidate !== 'personal') throw new Error(`Unknown account: ${candidate}`);
      await authorizeCalendar(config, candidate);
      output.write(`Authorized ${candidate} calendar.\n`);
    }
  });

program
  .command('migrate-storage')
  .description('Create the yearly e-ink gallery and remove retained full-color outputs')
  .action(async () => {
    const result = await migrateLegacyStorage();
    output.write(`Storage migrated${result.editionDate ? ` through ${result.editionDate}` : ''}; preserved ${result.migratedDates.length} dated e-ink edition(s) and removed ${result.removedFullColorFiles} full-color files.\n`);
  });

program
  .command('style-study')
  .description('Generate four aesthetic directions across today and the next Monday; never uploads')
  .option('--rebuild <directory>', 'Rebuild contact sheets for an existing study without generating images')
  .option('--round <number>', 'Style-study round', '1')
  .action(async (options: { rebuild?: string; round: string }) => {
    if (options.rebuild) {
      const directory = path.resolve(options.rebuild);
      await rebuildStyleStudy(directory);
      output.write(`Rebuilt style-study contact sheets at ${directory}\n`);
      return;
    }
    const round = Number.parseInt(options.round, 10);
    const result = await runStyleStudy(await loadConfig(), round);
    output.write(`Created 8-image style study at ${result.root}\n`);
  });

program
  .command('generate')
  .description('Generate today’s candidate; uploads by default')
  .option('--no-upload', 'Generate and archive without updating the frame')
  .option('--force', 'Generate even if today already has an uploaded edition')
  .option('--date <date>', 'Preview a specific local date (YYYY-MM-DD); use with --no-upload')
  .option('--scheduled', 'Use LaunchAgent failure notification behavior')
  .action(async (options: { upload: boolean; force?: boolean; date?: string; scheduled?: boolean }) => {
    try {
      if (options.date && options.upload) throw new Error('--date requires --no-upload');
      if (options.date && !/^\d{4}-\d{2}-\d{2}$/.test(options.date)) throw new Error('--date must use YYYY-MM-DD');
      const manifest = await runPipeline(await loadConfig(), {
        upload: options.upload,
        force: Boolean(options.force),
        newConcept: false,
        mode: 'daily',
        date: options.date,
      });
      output.write(manifest ? `Created ${manifest.editionDate}/${manifest.runId}\n` : 'Today’s edition is already current.\n');
    } catch (error) {
      if (options.scheduled) sendScheduledFailureNotification();
      fail(error);
    }
  });

program
  .command('run')
  .description('LaunchAgent entrypoint; equivalent to generate')
  .option('--scheduled', 'Show a local notification on failure')
  .option('--no-upload', 'Generate without updating the frame')
  .action(async (options: { scheduled?: boolean; upload: boolean }) => {
    try {
      const manifest = await runPipeline(await loadConfig(), {
        upload: options.upload,
        force: false,
        newConcept: false,
        mode: 'daily',
      });
      output.write(manifest ? `Created ${manifest.editionDate}/${manifest.runId}\n` : 'Today’s edition is already current.\n');
    } catch (error) {
      if (options.scheduled) sendScheduledFailureNotification();
      fail(error);
    }
  });

program
  .command('regenerate')
  .description('Create a new composition for today')
  .option('--new-concept', 'Choose a different eligible anchor or metaphor')
  .option('--no-upload', 'Archive without updating the frame')
  .action(async (options: { newConcept?: boolean; upload: boolean }) => {
    const manifest = await runPipeline(await loadConfig(), {
      upload: options.upload,
      force: true,
      newConcept: Boolean(options.newConcept),
      mode: options.newConcept ? 'new-concept' : 'regenerate',
    });
    if (manifest) output.write(`Created ${manifest.editionDate}/${manifest.runId}\n`);
  });

program
  .command('upload')
  .description('Upload an existing exact 800×480 24-bit BMP')
  .argument('<bmp>', 'BMP path')
  .action(async (bmp: string) => {
    const receipt = await uploadBmpFile(await loadConfig(), path.resolve(bmp));
    output.write(`Upload verified through ${receipt.host} at ${receipt.verifiedAt}.\n`);
  });

program
  .command('restore')
  .description('Publish the saved candidate or restore the published edition for a date')
  .argument('<date>', 'YYYY-MM-DD')
  .action(async (date: string) => {
    const config = await loadConfig();
    const stored = await loadCandidate(date) ?? await loadEdition(date);
    if (!stored) throw new Error(`No e-ink candidate or published edition found for ${date}`);
    const receipt = await uploadBmp(config, stored.bmp);
    stored.manifest.uploadedAt = receipt.verifiedAt;
    stored.manifest.uploadVerified = true;
    await promoteLatest(stored.manifest, stored.png, stored.bmp);
    output.write(`Restored ${date}/${stored.manifest.runId}.\n`);
  });

program
  .command('status')
  .description('Show last successful edition and last failure')
  .action(async () => {
    const state = await loadState();
    output.write(`${JSON.stringify(state, null, 2)}\n`);
  });

program
  .command('doctor')
  .description('Check configuration, credentials, data sources, and display reachability')
  .action(async () => {
    const config = await loadConfig();
    const secretAccounts = config.calendar.provider === 'google'
      ? ['google-oauth-client-secret', 'google-oauth-token-work', 'google-oauth-token-personal', 'vercel-ai-gateway-key']
      : ['vercel-ai-gateway-key'];
    const secretChecks = await Promise.all(secretAccounts.map((account) => hasSecret(account)));
    const names = config.calendar.provider === 'google'
      ? ['Google OAuth client', 'work calendar token', 'personal calendar token', 'Gateway key']
      : ['Gateway key'];
    names.forEach((name, index) => output.write(`${secretChecks[index] ? '✓' : '✗'} ${name}\n`));
    if (secretChecks.every(Boolean)) {
      const events = await fetchTodayEvents(config);
      output.write(`✓ Calendar (${config.calendar.provider}, ${events.length} normalized events today)\n`);
    }
    const weather = await fetchWeather(config);
    output.write(`✓ Weather (${weather.provider})\n`);
    const display = await checkDisplay(config);
    output.write(`${display.reachable ? '✓' : '✗'} PhotoPainter (${display.host})\n`);
    if (!secretChecks.every(Boolean) || !display.reachable) process.exitCode = 1;
  });

program
  .command('bakeoff')
  .description('Generate a blind 12-scene Gemini/Grok six-color comparison using synthetic inputs')
  .option('--models <models>', 'Two comma-separated AI Gateway model slugs')
  .action(async (options: { models?: string }) => {
    const models = options.models?.split(',').map((model) => model.trim()).filter(Boolean);
    const file = await runBichonBakeoff(await loadConfig(), models);
    output.write(`Blind bakeoff created: ${file}\nOpen index.html before answers.json.\n`);
  });

program
  .command('set-image-model')
  .description('Change the image model slug')
  .argument('<model>', 'AI Gateway model slug')
  .action(async (model: string) => {
    const config = await loadConfig();
    config.models.image = model;
    await saveConfig(config);
    output.write(`Image model set to ${model}.\n`);
  });

program
  .command('install-agent')
  .description('Install the 5:30am per-user LaunchAgent')
  .action(async () => {
    const config = await loadConfig();
    await fetchTodayEvents(config);
    await installLaunchAgent(config);
    output.write(`Installed ${paths.launchAgent}\n`);
  });

program
  .command('uninstall-agent')
  .description('Unload the LaunchAgent without deleting archives or configuration')
  .action(async () => {
    await uninstallLaunchAgent();
    output.write('LaunchAgent unloaded.\n');
  });

program
  .command('kick')
  .description('Run the installed LaunchAgent now')
  .action(async () => {
    await kickstartLaunchAgent();
    output.write('LaunchAgent started.\n');
  });

program.parseAsync().catch((error) => {
  if (error instanceof Error && error.message === '__handled__') return;
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
