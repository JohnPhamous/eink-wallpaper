import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, ensureDirectory } from './fs.js';
import { paths } from './paths.js';
import { dateKey, todayBounds } from './time.js';
import type { AppConfig, WeatherSnapshot } from './types.js';

interface CachedValue<T> {
  fetchedAt: string;
  value: T;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string, userAgent: string, attempts = [0, 5_000, 15_000, 45_000]): Promise<T> {
  let lastError: unknown;
  for (const delay of attempts) {
    if (delay) await sleep(delay);
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': userAgent, Accept: 'application/geo+json, application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return (await response.json()) as T;
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable) throw new Error(`HTTP ${response.status} from weather provider`);
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(retryAfter * 1000, 60_000));
      lastError = new Error(`HTTP ${response.status} from weather provider`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Weather request failed');
}

async function readCache<T>(name: string): Promise<CachedValue<T> | undefined> {
  try {
    return JSON.parse(await readFile(path.join(paths.cache, name), 'utf8')) as CachedValue<T>;
  } catch {
    return undefined;
  }
}

async function writeCache<T>(name: string, value: T): Promise<void> {
  await ensureDirectory(paths.cache);
  await atomicWrite(
    path.join(paths.cache, name),
    `${JSON.stringify({ fetchedAt: new Date().toISOString(), value })}\n`,
  );
}

interface NwsPoints {
  properties: {
    forecast: string;
    forecastHourly: string;
    gridId: string;
    gridX: number;
    gridY: number;
    timeZone: string;
  };
}

interface NwsForecast {
  properties: {
    generatedAt?: string;
    periods: Array<{
      name: string;
      startTime: string;
      endTime: string;
      isDaytime: boolean;
      temperature: number;
      temperatureUnit: string;
      windSpeed: string;
      windDirection: string;
      shortForecast: string;
      probabilityOfPrecipitation?: { value?: number | null };
    }>;
  };
}

interface NwsAlerts {
  features: Array<{
    properties: {
      event?: string;
      severity?: string;
      headline?: string;
      status?: string;
    };
  }>;
}

async function nwsPoints(config: AppConfig): Promise<NwsPoints> {
  const cached = await readCache<NwsPoints>('nws-points.json');
  const age = cached ? Date.now() - new Date(cached.fetchedAt).getTime() : Infinity;
  if (cached && age < 30 * 86_400_000) return cached.value;
  const point = await fetchJson<NwsPoints>(
    `https://api.weather.gov/points/${config.weather.latitude},${config.weather.longitude}`,
    config.weather.userAgent,
  );
  await writeCache('nws-points.json', point);
  return point;
}

function summarizeNws(
  daily: NwsForecast,
  hourly: NwsForecast,
  alerts: NwsAlerts | undefined,
  alertsUnavailable: boolean,
  timezone: string,
  targetDate: string,
): WeatherSnapshot {
  const isTargetDate = (value: string): boolean => dateKey(new Date(value), timezone) === targetDate;
  const day = daily.properties.periods.find((period) => period.isDaytime && isTargetDate(period.startTime));
  const night = daily.properties.periods.find((period) => !period.isDaytime && isTargetDate(period.startTime));
  const targetHours = hourly.properties.periods.filter((period) => isTargetDate(period.startTime));
  const nextHours = targetHours.slice(0, 12);
  if (!day && nextHours.length === 0) throw new Error(`NWS forecast does not cover ${targetDate}`);
  const precipitationChance = Math.max(
    0,
    ...nextHours.map((period) => period.probabilityOfPrecipitation?.value ?? 0),
  );
  const conditions = [...new Set(nextHours.map((period) => period.shortForecast).filter(Boolean))].slice(0, 3);
  const alertItems = (alerts?.features ?? [])
    .filter((feature) => feature.properties.status !== 'Test')
    .map((feature) => ({
      event: feature.properties.event ?? 'Weather alert',
      severity: feature.properties.severity ?? 'Unknown',
      headline: feature.properties.headline ?? feature.properties.event ?? 'Weather alert',
    }));
  const severe = alertItems.some((alert) => /extreme|severe/i.test(alert.severity));
  const notable = severe || precipitationChance >= 60 || nextHours.some((period) => /snow|thunder|fog|wind|hail/i.test(period.shortForecast));
  return {
    provider: 'NWS',
    fetchedAt: new Date().toISOString(),
    timezone,
    summary: conditions.join(' becoming ') || day?.shortForecast || 'Weather unavailable',
    highF: day?.temperatureUnit === 'F' ? day.temperature : undefined,
    lowF: night?.temperatureUnit === 'F' ? night.temperature : undefined,
    precipitationChance,
    wind: nextHours[0] ? `${nextHours[0].windDirection} ${nextHours[0].windSpeed}` : undefined,
    notable,
    severe,
    alertsUnavailable,
    alerts: alertItems,
  };
}

async function fetchNws(config: AppConfig, targetDate: string): Promise<WeatherSnapshot> {
  const points = await nwsPoints(config);
  const alertsUrl = `https://api.weather.gov/alerts/active?point=${config.weather.latitude},${config.weather.longitude}`;
  const [daily, hourly, alertResult] = await Promise.all([
    fetchJson<NwsForecast>(points.properties.forecast, config.weather.userAgent),
    fetchJson<NwsForecast>(points.properties.forecastHourly, config.weather.userAgent),
    fetchJson<NwsAlerts>(alertsUrl, config.weather.userAgent).then(
      (value) => ({ value, error: false as const }),
      () => ({ value: undefined, error: true as const }),
    ),
  ]);
  return summarizeNws(daily, hourly, alertResult.value, alertResult.error, points.properties.timeZone, targetDate);
}

interface OpenMeteoForecast {
  timezone: string;
  hourly: {
    time: string[];
    temperature_2m: number[];
    precipitation_probability: number[];
    weather_code: number[];
    wind_speed_10m: number[];
  };
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    weather_code: number[];
  };
}

function wmoSummary(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  if (code <= 99) return 'Thunderstorms';
  return 'Variable weather';
}

async function fetchOpenMeteo(config: AppConfig, targetDate: string): Promise<WeatherSnapshot> {
  const params = new URLSearchParams({
    latitude: String(config.weather.latitude),
    longitude: String(config.weather.longitude),
    timezone: config.timezone,
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    forecast_days: '7',
    hourly: 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
  });
  const data = await fetchJson<OpenMeteoForecast>(
    `https://api.open-meteo.com/v1/forecast?${params}`,
    config.weather.userAgent,
  );
  const dayIndex = data.daily.time.indexOf(targetDate);
  if (dayIndex < 0) throw new Error(`Open-Meteo forecast does not cover ${targetDate}`);
  const firstHour = data.hourly.time.findIndex((time) => time.startsWith(targetDate));
  const precipitationChance = data.daily.precipitation_probability_max[dayIndex] ?? 0;
  const code = data.daily.weather_code[dayIndex] ?? 0;
  const summary = wmoSummary(code);
  const notable = precipitationChance >= 60 || /snow|thunder|fog/i.test(summary);
  return {
    provider: 'Open-Meteo',
    fetchedAt: new Date().toISOString(),
    timezone: data.timezone,
    summary,
    highF: data.daily.temperature_2m_max[dayIndex],
    lowF: data.daily.temperature_2m_min[dayIndex],
    precipitationChance,
    wind: firstHour >= 0 && data.hourly.wind_speed_10m[firstHour] !== undefined
      ? `${Math.round(data.hourly.wind_speed_10m[firstHour])} mph`
      : undefined,
    notable,
    severe: false,
    alertsUnavailable: true,
    alerts: [],
  };
}

export async function fetchWeather(
  config: AppConfig,
  targetDate = todayBounds(config.timezone).date,
): Promise<WeatherSnapshot> {
  try {
    const weather = await fetchNws(config, targetDate);
    await writeCache('weather-last-good.json', weather);
    return weather;
  } catch (nwsError) {
    try {
      const weather = await fetchOpenMeteo(config, targetDate);
      await writeCache('weather-last-good.json', weather);
      return weather;
    } catch (fallbackError) {
      throw new AggregateError([nwsError, fallbackError], 'Both weather providers failed; preserving the current display');
    }
  }
}
