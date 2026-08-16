export type AccountName = 'work' | 'personal';

export interface AppConfig {
  schemaVersion: 1;
  timezone: 'America/Los_Angeles';
  display: {
    host: string;
    endpoint: '/dataUP';
    timeoutMs: number;
  };
  calendar: {
    provider: 'eventkit' | 'google';
    clientId?: string;
    accounts: AccountName[];
    excludedCalendarNames: string[];
    excludedEventTitlePrefixes: string[];
    workSourceMatchers: string[];
  };
  weather: {
    latitude: number;
    longitude: number;
    userAgent: string;
  };
  models: {
    brief: string;
    image: 'google/gemini-3.1-flash-image' | 'xai/grok-imagine-image-2.0' | string;
    qa: string;
    imageSize: '1K' | '2K';
  };
  schedule: {
    hour: number;
    minute: number;
  };
  art: {
    collarColor: 'cobalt blue';
    conceptMemoryDays: number;
    gymAnchorCooldownDays: number;
    recurringWorkCooldownDays: number;
  };
}

export interface NormalizedEvent {
  idHash: string;
  account: AccountName;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  notes?: string;
  recurring: boolean;
  organizer: boolean;
  attendeeCount: number;
  responseStatus: 'accepted' | 'needsAction' | 'tentative' | 'declined' | 'unknown';
  transparency: 'opaque' | 'transparent';
  eligibleAnchor: boolean;
  baseScore: number;
  reasons: string[];
}

export interface WeatherSnapshot {
  provider: 'NWS' | 'Open-Meteo';
  fetchedAt: string;
  timezone: string;
  summary: string;
  highF?: number;
  lowF?: number;
  precipitationChance?: number;
  wind?: string;
  notable: boolean;
  severe: boolean;
  alertsUnavailable: boolean;
  alerts: Array<{ event: string; severity: string; headline: string }>;
}

export interface CreativeBrief {
  title: string;
  anchorEventIdHash?: string;
  eventCues: Array<{
    eventIdHash: string;
    eventTitle: string;
    cue: string;
    prominence: 'primary' | 'secondary';
    visualGroup?: string;
  }>;
  anchorRationale: string;
  metaphor: string;
  setting: string;
  bichonAction: string;
  mood: string;
  lighting: string;
  palette: string[];
  weatherMotif: string;
  composition: string;
  visualPlan?: {
    focalHierarchy: string;
    camera: string;
    silhouetteAndGesture: string;
    depthAndScale: string;
    valueAndLighting: string;
    colorStrategy: string;
    eyePathAndNegativeSpace: string;
  };
  scenePrompt: string;
  avoid: string[];
  conceptKey: string;
  story?: StoryContinuity;
}

export type WorldLocationKey = string;

export interface StoryContinuity {
  editionKind: 'daily-chapter' | 'sunday-tapestry';
  worldLocationKey: WorldLocationKey;
  worldLocationDescription: string;
  narrativeBeat: string;
  carriedMotifs: string[];
  weeklyEchoes: Array<{
    sourceDate: string;
    eventTitle: string;
    cue: string;
  }>;
  anniversaryEcho?: {
    sourceDate: string;
    motif: string;
    reinterpretation: string;
  };
}

export interface StoryMemory {
  sourceDate: string;
  title: string;
  setting: string;
  metaphor: string;
  eventCues: CreativeBrief['eventCues'];
  worldLocationKey?: WorldLocationKey;
  worldLocationDescription?: string;
  narrativeBeat?: string;
  carriedMotifs: string[];
}

export interface NarrativeContext {
  editionKind: StoryContinuity['editionKind'];
  previousChapter?: StoryMemory;
  locationHistory: Array<{
    key: WorldLocationKey;
    description: string;
    appearances: number;
    lastUsed: string;
  }>;
  recentMotifs: Array<{ sourceDate: string; motifs: string[] }>;
  weeklyMemories: StoryMemory[];
  anniversary?: StoryMemory;
}

export interface QaResult {
  pass: boolean;
  reasons: string[];
  correction: string;
  scores?: {
    focalHierarchy: number;
    compositionAndDepth: number;
    melloAppeal: number;
    calendarFidelity: number;
    originalityAndSpecificity: number;
    styleAndCraft: number;
    einkReadability: number;
    average: number;
  };
}

export interface EditionManifest {
  schemaVersion: 2;
  editionDate: string;
  runId: string;
  generatedAt: string;
  inputHash: string;
  mode: 'daily' | 'regenerate' | 'new-concept';
  model: string;
  brief: CreativeBrief;
  qa: QaResult;
  uploadedAt?: string;
  uploadVerified?: boolean;
  rejected?: boolean;
}

export interface RunOptions {
  upload: boolean;
  force: boolean;
  newConcept: boolean;
  mode: EditionManifest['mode'];
  date?: string;
}
