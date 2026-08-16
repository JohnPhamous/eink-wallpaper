import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { google, type calendar_v3 } from 'googleapis';
import { getSecret, setSecret } from './keychain.js';
import { hash } from './hash.js';
import { todayBounds } from './time.js';
import type { AccountName, AppConfig, NormalizedEvent } from './types.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const execFileAsync = promisify(execFile);
const eventKitReader = fileURLToPath(new URL('../bin/eink-calendar-reader', import.meta.url));

function tokenKey(account: AccountName): string {
  return `google-oauth-token-${account}`;
}

function oauthClient(config: AppConfig, clientSecret: string, redirectUri?: string) {
  if (!config.calendar.clientId) throw new Error('Google Calendar OAuth client is not configured');
  return new google.auth.OAuth2(config.calendar.clientId, clientSecret, redirectUri);
}

export async function authorizeCalendar(config: AppConfig, account: AccountName): Promise<void> {
  const clientSecret = await getSecret('google-oauth-client-secret');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to start OAuth callback server');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const client = oauthClient(config, clientSecret, redirectUri);
  const state = randomBytes(24).toString('hex');
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: [CALENDAR_SCOPE],
    state,
  });

  const tokenPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('OAuth authorization timed out')), 5 * 60_000);
    server.on('request', async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2callback') {
          response.writeHead(404).end();
          return;
        }
        if (url.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
        const error = url.searchParams.get('error');
        if (error) throw new Error(`Google authorization failed: ${error}`);
        const code = url.searchParams.get('code');
        if (!code) throw new Error('Google did not return an authorization code');
        const { tokens } = await client.getToken(code);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h1>Calendar connected</h1><p>You may close this window.</p>');
        clearTimeout(timer);
        resolve(tokens as Record<string, unknown>);
      } catch (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Calendar authorization failed. Return to Terminal.');
        clearTimeout(timer);
        reject(error);
      }
    });
  });

  process.stdout.write(`Opening Google authorization for ${account}…\n${authUrl}\n`);
  spawn('/usr/bin/open', [authUrl], { detached: true, stdio: 'ignore' }).unref();
  try {
    const tokens = await tokenPromise;
    await setSecret(tokenKey(account), JSON.stringify(tokens));
  } finally {
    server.close();
  }
}

export async function authorizeLocalCalendar(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(eventKitReader, ['authorize'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`EventKit authorization exited ${code}`));
    });
  });
}

async function calendarClient(config: AppConfig, account: AccountName): Promise<calendar_v3.Calendar> {
  const [clientSecret, tokenJson] = await Promise.all([
    getSecret('google-oauth-client-secret'),
    getSecret(tokenKey(account)),
  ]);
  const client = oauthClient(config, clientSecret);
  client.setCredentials(JSON.parse(tokenJson));
  client.on('tokens', async (tokens) => {
    const previous = JSON.parse(await getSecret(tokenKey(account))) as Record<string, unknown>;
    await setSecret(tokenKey(account), JSON.stringify({ ...previous, ...tokens }));
  });
  return google.calendar({ version: 'v3', auth: client });
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeNotes(value?: string | null): string | undefined {
  if (!value) return undefined;
  const sanitized = stripHtml(value)
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, '[phone removed]')
    .replace(/(?:passcode|password|pin|meeting id|dial[- ]?in)\s*[:#]?\s*\S+/gi, '[access detail removed]')
    .replace(/\b(?:zoom|google meet|microsoft teams|webex)\b[^.\n]*/gi, '[video details removed]')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized ? sanitized.slice(0, 500) : undefined;
}

function sanitizeLocation(value: string | null | undefined, recurring: boolean): string | undefined {
  if (!value) return undefined;
  const trimmed = stripHtml(value);
  if (/https?:|zoom|meet\.google|teams|webex|dial[- ]?in/i.test(trimmed)) return undefined;
  if (/^(room|conf(?:erence)? room|virtual)\b/i.test(trimmed)) return undefined;
  if (recurring && !/\d{2,}[^,]*(?:st|street|ave|avenue|rd|road|blvd|way|drive|dr)\b/i.test(trimmed)) return undefined;
  return trimmed.slice(0, 180);
}

function titleSignals(title: string): { bonus: number; reasons: string[] } {
  const lower = title.toLowerCase();
  const reasons: string[] = [];
  let bonus = 0;
  if (/\b(ooo|out of office|flight|travel|trip|conference|launch|milestone|anniversary|celebration)\b/.test(lower)) {
    bonus += 35;
    reasons.push('major day-shaping event');
  }
  if (/\b(interview|hiring|performance review|perf review|calibration|epd review|design forum|design leads)\b/.test(lower)) {
    bonus += 12;
    reasons.push('high-signal work event');
  }
  if (/\b(1:?1|one on one|sync|standup|office hours)\b/.test(lower)) {
    bonus -= 8;
    reasons.push('routine meeting');
  }
  if (/\b(gym|workout|training|lift)\b/.test(lower)) {
    bonus -= 2;
    reasons.push('recurring fitness event');
  }
  return { bonus, reasons };
}

function normalizeEvent(event: calendar_v3.Schema$Event, account: AccountName): NormalizedEvent | undefined {
  if (!event.id || !event.summary || event.status === 'cancelled') return undefined;
  const self = event.attendees?.find((attendee) => attendee.self);
  const responseStatus = (self?.responseStatus ?? (event.organizer?.self ? 'accepted' : 'unknown')) as NormalizedEvent['responseStatus'];
  if (responseStatus === 'declined') return undefined;
  const recurring = Boolean(event.recurringEventId || event.recurrence?.length);
  const organizer = Boolean(event.organizer?.self);
  const transparency = event.transparency === 'transparent' ? 'transparent' : 'opaque';
  const optional = Boolean(self?.optional);
  const administrative = /\b(focus time|admin|hold|block|working location|reminder|busy)\b/i.test(event.summary);
  const eligibleAnchor =
    (responseStatus === 'accepted' || organizer) &&
    responseStatus !== 'tentative' &&
    transparency !== 'transparent' &&
    !optional &&
    !administrative;
  const allDay = Boolean(event.start?.date);
  const start = event.start?.dateTime ?? event.start?.date;
  const end = event.end?.dateTime ?? event.end?.date;
  if (!start || !end) return undefined;
  const location = sanitizeLocation(event.location, recurring);
  const signals = titleSignals(event.summary);
  let baseScore = account === 'personal' ? 30 : 20;
  if (!recurring) baseScore += 12;
  else baseScore -= account === 'work' ? 10 : 5;
  if (location) baseScore += 7;
  if (allDay) baseScore += 4;
  baseScore += signals.bonus;
  return {
    idHash: hash(`${account}:${event.recurringEventId ?? event.id}`),
    account,
    title: stripHtml(event.summary).slice(0, 180),
    start,
    end,
    allDay,
    location,
    notes: sanitizeNotes(event.description),
    recurring,
    organizer,
    attendeeCount: event.attendees?.length ?? 0,
    responseStatus,
    transparency,
    eligibleAnchor,
    baseScore,
    reasons: [account === 'personal' ? 'personal calendar' : 'work calendar', ...signals.reasons],
  };
}

interface EventKitEvent {
  eventIdentifier: string;
  calendarName: string;
  sourceName: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  recurring: boolean;
  organizer: boolean;
  attendeeCount: number;
  responseStatus: NormalizedEvent['responseStatus'];
  transparency: NormalizedEvent['transparency'];
}

function eventKitAccount(config: AppConfig, sourceName: string): AccountName {
  const normalized = sourceName.toLocaleLowerCase('en-US');
  return config.calendar.workSourceMatchers.some((matcher) => normalized.includes(matcher.toLocaleLowerCase('en-US')))
    ? 'work'
    : 'personal';
}

function normalizeEventKitEvent(config: AppConfig, event: EventKitEvent): NormalizedEvent | undefined {
  if (!event.eventIdentifier || !event.title) return undefined;
  const account = eventKitAccount(config, event.sourceName);
  const responseStatus = event.responseStatus;
  if (responseStatus === 'declined') return undefined;
  const administrative = /\b(focus time|admin|hold|block|working location|reminder|busy)\b/i.test(event.title);
  const eligibleAnchor =
    (responseStatus === 'accepted' || event.organizer) &&
    responseStatus !== 'tentative' &&
    event.transparency !== 'transparent' &&
    !administrative;
  const location = sanitizeLocation(event.location, event.recurring);
  const signals = titleSignals(event.title);
  let baseScore = account === 'personal' ? 30 : 20;
  if (!event.recurring) baseScore += 12;
  else baseScore -= account === 'work' ? 10 : 5;
  if (location) baseScore += 7;
  if (event.allDay) baseScore += 4;
  baseScore += signals.bonus;
  return {
    idHash: hash(`${event.eventIdentifier}:${event.start}`),
    account,
    title: stripHtml(event.title).slice(0, 180),
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location,
    notes: sanitizeNotes(event.notes),
    recurring: event.recurring,
    organizer: event.organizer,
    attendeeCount: event.attendeeCount,
    responseStatus,
    transparency: event.transparency,
    eligibleAnchor,
    baseScore,
    reasons: [account === 'personal' ? 'personal calendar' : 'work calendar', ...signals.reasons],
  };
}

function normalizedCalendarName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

async function listedCalendars(
  client: calendar_v3.Calendar,
): Promise<calendar_v3.Schema$CalendarListEntry[]> {
  const calendars: calendar_v3.Schema$CalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.calendarList.list({
      maxResults: 250,
      minAccessRole: 'reader',
      pageToken,
      showDeleted: false,
    });
    calendars.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return calendars;
}

async function fetchTodayGoogleEvents(config: AppConfig, now = new Date()): Promise<NormalizedEvent[]> {
  const bounds = todayBounds(config.timezone, now);
  const excludedNames = new Set(config.calendar.excludedCalendarNames.map(normalizedCalendarName));
  const clients = await Promise.all(
    config.calendar.accounts.map(async (account) => {
      const client = await calendarClient(config, account);
      return { account, client, calendars: await listedCalendars(client) };
    }),
  );
  const uniqueCalendars = new Map<string, { account: AccountName; client: calendar_v3.Calendar; id: string }>();
  for (const { account, client, calendars } of clients) {
    for (const calendar of calendars) {
      const id = calendar.id;
      const name = calendar.summaryOverride ?? calendar.summary ?? '';
      if (!id || excludedNames.has(normalizedCalendarName(name)) || uniqueCalendars.has(id)) continue;
      uniqueCalendars.set(id, { account, client, id });
    }
  }
  const perCalendar = await Promise.all(
    [...uniqueCalendars.values()].map(async ({ account, client, id }) => {
      const response = await client.events.list({
        calendarId: id,
        timeMin: bounds.start.toISOString(),
        timeMax: bounds.end.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        showDeleted: false,
        maxResults: 2500,
      });
      return response.data.items?.map((event) => normalizeEvent(event, account)).filter(Boolean) ?? [];
    }),
  );
  return perCalendar.flat() as NormalizedEvent[];
}

async function fetchTodayEventKitEvents(config: AppConfig, now = new Date()): Promise<NormalizedEvent[]> {
  const bounds = todayBounds(config.timezone, now);
  const { stdout } = await execFileAsync(eventKitReader, [
    'events',
    bounds.start.toISOString(),
    bounds.end.toISOString(),
  ], { maxBuffer: 10 * 1024 * 1024 });
  const excludedNames = new Set(config.calendar.excludedCalendarNames.map(normalizedCalendarName));
  const events = JSON.parse(stdout) as EventKitEvent[];
  return events
    .filter((event) => !excludedNames.has(normalizedCalendarName(event.calendarName)))
    .map((event) => normalizeEventKitEvent(config, event))
    .filter((event): event is NormalizedEvent => Boolean(event))
    .sort((a, b) => a.start.localeCompare(b.start));
}

export async function fetchTodayEvents(config: AppConfig, now = new Date()): Promise<NormalizedEvent[]> {
  const events = config.calendar.provider === 'eventkit'
    ? fetchTodayEventKitEvents(config, now)
    : fetchTodayGoogleEvents(config, now);
  const excludedPrefixes = config.calendar.excludedEventTitlePrefixes.map((prefix) => prefix.trim().toLocaleLowerCase('en-US'));
  return (await events).filter((event) => {
    const title = event.title.trim().toLocaleLowerCase('en-US');
    return !excludedPrefixes.some((prefix) => title.startsWith(prefix));
  });
}
