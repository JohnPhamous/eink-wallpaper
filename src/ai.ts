import { createGateway, generateText } from 'ai';
import { z } from 'zod';
import { getSecret } from './keychain.js';
import type { AppConfig, CreativeBrief, NormalizedEvent, QaResult, WeatherSnapshot } from './types.js';

const briefSchema = z.object({
  title: z.string().min(1).max(100),
  anchorEventIdHash: z.string().optional(),
  anchorRationale: z.string().min(1).max(300),
  metaphor: z.string().min(1).max(300),
  setting: z.string().min(1).max(300),
  bichonAction: z.string().min(1).max(300),
  mood: z.string().min(1).max(300),
  lighting: z.string().min(1).max(300),
  palette: z.array(z.string()).min(3).max(8),
  weatherMotif: z.string().min(1).max(200),
  composition: z.string().min(1).max(300),
  scenePrompt: z.string().min(1).max(1800),
  avoid: z.array(z.string()).min(1).max(20),
  conceptKey: z.string().min(1).max(120),
});

const qaSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()).max(12),
  correction: z.string().max(700),
});

const gatewayPrivacy = {
  zeroDataRetention: true,
  disallowPromptTraining: true,
} as const;

const MODEL_TIMEOUT_MS = 120_000;

async function prepareGateway(): Promise<ReturnType<typeof createGateway>> {
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? await getSecret('vercel-ai-gateway-key');
  return createGateway({ apiKey });
}

function parseJson<T>(text: string, schema: z.ZodType<T>): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return schema.parse(JSON.parse(candidate));
}

function safeEvents(events: NormalizedEvent[]): Array<Record<string, unknown>> {
  return events.map((event) => ({
    id: event.idHash,
    account: event.account,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    location: event.location,
    notes: event.notes,
    recurring: event.recurring,
    organizer: event.organizer,
    attendeeCount: event.attendeeCount,
    participation: event.responseStatus,
    eligibleAnchor: event.eligibleAnchor,
    deterministicScore: event.baseScore,
    rankingSignals: event.reasons,
  }));
}

export async function createBrief(
  config: AppConfig,
  editionDate: string,
  events: NormalizedEvent[],
  weather: WeatherSnapshot,
  conceptHistory: Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }>,
  newConcept: boolean,
  studyDirection?: string,
): Promise<CreativeBrief> {
  const gateway = await prepareGateway();
  const now = Date.now();
  const recentlyAnchored = (event: NormalizedEvent, days: number): boolean => conceptHistory.some((entry) =>
    !entry.rejected &&
    entry.brief.anchorEventIdHash === event.idHash &&
    now - new Date(entry.generatedAt).getTime() < days * 86_400_000,
  );
  const rankedEligible = events
    .filter((event) => {
      if (!event.eligibleAnchor) return false;
      if (/\b(gym|workout|training|lift)\b/i.test(event.title) && recentlyAnchored(event, config.art.gymAnchorCooldownDays)) return false;
      if (event.account === 'work' && event.recurring && recentlyAnchored(event, config.art.recurringWorkCooldownDays)) return false;
      return true;
    })
    .sort((a, b) => b.baseScore - a.baseScore || a.start.localeCompare(b.start));
  const personalEligible = rankedEligible.filter((event) => event.account === 'personal');
  const eligible = !weather.severe && personalEligible.length > 0 ? personalEligible : rankedEligible;
  const history = conceptHistory.slice(0, 30).map((entry) => ({
    date: entry.generatedAt.slice(0, 10),
    conceptKey: entry.brief.conceptKey,
    metaphor: entry.brief.metaphor,
    anchor: entry.brief.anchorEventIdHash,
    palette: entry.brief.palette,
    rejected: entry.rejected,
  }));
  const eligibleIds = new Set(eligible.map((event) => event.idHash));
  const system = `You are the creative director for one text-free daily artwork on a six-color e-ink frame.
Return one strict JSON object and nothing else. Facts are sacred; visual metaphor is free.

Non-negotiable visual rules:
- Exactly one living character: a single white fluffy bichon dog. No people, animals, robots, creatures, faces in clouds, silhouettes, crowds, or background figures.
- The bichon is an irresistibly cute chibi quadruped, occasionally upright for a physically motivated action, with a subtle cobalt-blue collar and no other costume. Use an oversized round fluffy head, compact cloud-like body, short legs, tiny rounded paws, huge dark expressive eyes, tiny nose and soft muzzle, and puffy ears. Roughly 2 heads long; clearly canine, never humanoid, baby-like, plush, or 3D-mascot-like.
- Keep the bichon fully visible at roughly 30-35% of frame height. Use restrained cobalt or deep-black separation only where its white fur would otherwise disappear; avoid mascot-like heavy outlining.
- Absolutely no readable text, letters, numbers, signage, logos, UI, calendars, clocks, captions, or watermarks.
- One full-bleed cinematic landscape scene, no panels, widgets, borders, picture frames, poster margins, boxes, insets, or vignettes.
- The world is visibly unoccupied except for the bichon. Never place figures or silhouettes inside windows, vehicles, reflections, distant architecture, or implied workplaces.
- Contemporary hand-drawn adventure-anime keyframe language: simplified expressive contours, reduced line density, elastic squash-and-stretch, dynamic foreshortening, strong motion arcs, and bold cel-shaped shadow/highlight masses. The bichon must read as a lively 2D drawing integrated into a dimensional painterly environment—not a photograph, realistic render, plush toy, or soft 3D animation still.
- Blend painterly environmental textures and subtle depth into broad graphic shapes. Use an asymmetrical cinematic camera and a decisive action pose. Sophisticated, warm, serene, lightly funny; never childish, mascot-like, or anxious. Do not reference or reproduce any existing franchise, character, costume, symbol, or setting.
- Compose centrally for a 16:9 source that will lose 3.125% from each side before becoming 5:3. Use strong silhouettes and broad color regions that survive six-color dithering.
- Make cobalt/ultramarine blue and emerald/leaf green the unmistakable dominant chromatic masses—roughly 70% of the colored area—supported by white and deep black. Restrict coral red and warm yellow to a few small focal accents, together under roughly 15% of the frame. Avoid beige, cream, lavender, gray, or brown dominance.
- Reserve soft blue-to-green gradients for limited sky, atmosphere, water, or reflection areas; preserve large saturated blue and green planes that survive the exact six-color conversion.
- Blend tactile dimensional materials inside those broad shapes. Avoid flat vector-mascot art, generic children's illustration, dense pavement seams, and tiny decorative detail.
- Use one unmistakable ordinary object or activity for the primary calendar event and, when meaningful, one subordinate object for a secondary event. A third small cue is allowed only when the day genuinely needs it. Keep every prop bold, simple, factual, unlabeled, and easy to identify after six-color conversion. No ornate machinery, gears, dials, tick marks, clock faces, segmented decorative platforms, or intricate floral constructions.
- Translate work concepts into natural, spatial, or sculptural metaphors. Never use desks, consoles, screens, dashboards, office interiors, holograms, wireframes, node networks, technical diagrams, floating UI, grids, or intricate geometric clusters.
- Keep the bichon physically active in the environment—running, leaping, climbing, carrying, digging, balancing, or exploring. Simple ordinary event objects may drive the action, but never pose the dog working at desks, screens, consoles, vehicles, or complex human machinery.
- Favor a closer cinematic tableau with the bichon actively carrying, nudging, arranging, opening, investigating, or moving toward the primary event object. Preserve enough environmental breathing room for weather, place, and mood.

Editorial rules:
- Personal significance outranks work; nonroutine outranks recurring; visual distinctiveness may override.
- The application has already enforced personal-first candidate selection. If eligibleAnchorCandidates contains personal events, work events are context only and cannot anchor.
- OOO, travel, conferences, launches, and milestones outrank ordinary meetings.
- Tentative, optional, free, or unaccepted events may influence atmosphere but can never anchor.
- Recurring events are eligible but receive a novelty penalty. Gym may anchor at most once per rolling 7 days. The same recurring work series may anchor at most once per rolling 30 days.
- Related events may become one honest theme. If nothing is visually meaningful, create a Seattle-weather-led bichon adventure.
- Ordinary weather changes only sky, light, wind, and ground conditions. Notable weather may become a stronger motif. A severe official alert overrides the calendar anchor.
- The primary event must be recognizable at a glance through a literal activity, setting, or ordinary event-specific object. Symbolism may enrich the scene but can never replace this concrete cue. Avoid generic glowing seeds, orbs, stones, portals, alignment rituals, mountain quests, unexplained smoke, and other visual metaphors that obscure the calendar meaning.
- Prefer objects specific enough to distinguish the event: a baby shower needs a tiny pair of baby booties, rattle, folded baby blanket, or similar cue alongside any gift; a medical checkup needs a recognizable unlabeled medical object; a workout needs a simple weight, band, or mat. A generic gift, bag, bowl, sphere, or landscape alone is insufficient when the event type offers a clearer ordinary object.
- When a meaningful secondary event exists, integrate one subordinate literal cue into the same coherent scene so the artwork feels like the day rather than a single isolated appointment.
- Freely invent composition, environment, motion, and visual relationships between factual objects. Never invent an obligation, person, destination, relationship, object implication, or weather condition.
- Avoid recent concepts, compositions, and palettes. ${newConcept ? 'The user explicitly requested a substantially new concept and eligible anchor where possible.' : ''}

${studyDirection ? `Aesthetic-study override—follow this while preserving the factual, privacy, single-character, no-text, and no-franchise rules:\n${studyDirection}` : ''}

Required JSON keys: title, anchorEventIdHash (optional), anchorRationale, metaphor, setting, bichonAction, mood, lighting, palette (3-8 plain color names), weatherMotif, composition, scenePrompt, avoid (array), conceptKey. List cobalt/ultramarine blue and emerald/leaf green first in palette. The scenePrompt must be a complete production prompt implementing every visual rule, including the compact chibi bichon, literal calendar cues, closer full-bleed tableau, fluid cel-and-gouache treatment, and blue-green color hierarchy.`;
  const input = {
    editionDate,
    timezone: config.timezone,
    weather,
    eligibleAnchorCandidates: safeEvents(eligible),
    contextOnlyEvents: safeEvents(events.filter((event) => !eligibleIds.has(event.idHash))),
    recentConceptsToAvoid: history,
  };
  const result = await generateText({
    model: gateway(config.models.brief),
    system,
    prompt: JSON.stringify(input),
    temperature: 0.8,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    providerOptions: { gateway: gatewayPrivacy },
  });
  const brief = parseJson(result.text, briefSchema);
  if (brief.anchorEventIdHash && !eligible.some((event) => event.idHash === brief.anchorEventIdHash)) {
    throw new Error('Creative director selected an ineligible or nonexistent anchor event');
  }
  return brief;
}

export async function generateArtwork(
  config: AppConfig,
  brief: CreativeBrief,
  correction?: string,
  aestheticDirection?: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const gateway = await prepareGateway();
  const prompt = `${brief.scenePrompt}

Style lock: a fluid hand-drawn 2D adventure-animation keyframe with broad gouache color masses, never photorealistic and never a 3D render. Use simplified expressive contours, reduced line density, elastic motion, dynamic foreshortening, cel-shaped light and shadow, pastel-futuristic atmosphere, and painterly dimensional environmental textures. The single bichon has a large round fluffy head, compact cloud-like body, short legs, tiny paws, huge dark expressive eyes, tiny muzzle, puffy ears, and roughly two-heads-long chibi proportions while remaining clearly canine. Use a closer full-bleed tableau with the fully visible dog at 30-35% frame height, actively interacting with one literal primary calendar cue and at most one subordinate secondary cue. Preserve scenic breathing room. Cobalt/ultramarine blue and emerald/leaf green must dominate the colored area; red and yellow are sparse focal accents only.

${aestheticDirection ? `Aesthetic study direction: ${aestheticDirection}\nThis direction overrides the generic medium and mark-making choices in the style lock, but never the subject, factual, composition-safe-area, palette-hierarchy, or hard-exclusion rules.` : ''}

Hard exclusions: ${[...brief.avoid, 'photorealism', 'realistic photography', '3D-rendered character', 'plush-toy appearance', 'soft CGI animation still', 'all text', 'all logos', 'every other character', 'cropped bichon', 'decorative border', 'picture frame', 'poster margin', 'panel', 'inset image', 'vignette', 'abstract glowing orb', 'generic symbolic stone', 'unexplained smoke'].join('; ')}.
Output one polished 16:9 landscape artwork. Keep the bichon and essential action inside the central 90% width safe area.
${correction ? `Mandatory correction—this overrides any conflicting object, palette, or composition instruction earlier in the prompt: ${correction}` : ''}`;

  if (config.models.image.startsWith('google/')) {
    const result = await generateText({
      model: gateway(config.models.image),
      prompt,
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      providerOptions: {
        gateway: gatewayPrivacy,
        google: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: config.models.imageSize },
        },
      },
    });
    const file = result.files.find((candidate) => candidate.mediaType.startsWith('image/'));
    if (!file) throw new Error('Image model returned no image');
    return { bytes: Buffer.from(file.uint8Array), mediaType: file.mediaType };
  }

  const module = (await import('ai')) as unknown as {
    generateImage?: (options: Record<string, unknown>) => Promise<{ image?: { uint8Array: Uint8Array; mediaType: string }; images?: Array<{ uint8Array: Uint8Array; mediaType: string }> }>;
    experimental_generateImage?: (options: Record<string, unknown>) => Promise<{ image?: { uint8Array: Uint8Array; mediaType: string }; images?: Array<{ uint8Array: Uint8Array; mediaType: string }> }>;
  };
  const generateImage = module.generateImage ?? module.experimental_generateImage;
  if (!generateImage) throw new Error('Installed AI SDK does not expose image generation');
  const result = await generateImage({
    model: gateway.imageModel(config.models.image),
    prompt,
    aspectRatio: '16:9',
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    providerOptions: { gateway: gatewayPrivacy },
  });
  const image = result.image ?? result.images?.[0];
  if (!image) throw new Error('Image model returned no image');
  return { bytes: Buffer.from(image.uint8Array), mediaType: image.mediaType };
}

export async function inspectArtwork(
  config: AppConfig,
  original: Buffer,
  displayPreview: Buffer,
  studyAcceptance?: string,
  brief?: CreativeBrief,
): Promise<QaResult> {
  const gateway = await prepareGateway();
  const result = await generateText({
    model: gateway(config.models.qa),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Inspect this candidate for a personal e-ink artwork. Return strict JSON only: {"pass":boolean,"reasons":string[],"correction":string}.
${brief ? `Validate semantic fidelity against this private creative brief: ${JSON.stringify({ anchorRationale: brief.anchorRationale, setting: brief.setting, bichonAction: brief.bichonAction, weatherMotif: brief.weatherMotif, scenePrompt: brief.scenePrompt })}` : ''}
Reject if: the single white fluffy bichon is absent or badly cropped; the bichon lacks the requested compact round-headed chibi appeal; any other living character, person, animal, robot, creature, silhouette, or face appears; any readable text, letters, numbers, signage, logo, UI, caption, or watermark appears; any decorative border, inset picture frame, panel, or boxed composition appears; severe anatomy errors; cluttered composition; weak central safe-area composition; childish tone; recognizable franchise imagery; photorealistic treatment; realistic photography; a plush-toy or soft 3D-rendered bichon; insufficient fluid hand-drawn cel-and-gouache character; an anchored calendar event is replaced by an unreadable abstract metaphor instead of a recognizable activity, setting, or ordinary object; the image contradicts the supplied brief; blue and green are not the clearly dominant chromatic masses; red/yellow overwhelm the blue-green hierarchy; or the overall scene becomes illegible in the exact black/white/green/blue/red/yellow palette. Any secondary event object explicitly requested by scenePrompt is required and must not be rejected merely because its event ranks below the primary anchor. Minor painterly ambiguity and small accent-hue shifts are acceptable. Do not reject solely because a sparse red or yellow accent darkens, shifts hue, or disappears after dithering when the subject, action, and blue-green composition remain clear. Chibi proportions are intentional and should not be rejected as childish when the overall direction remains sophisticated. ${studyAcceptance ?? ''} The correction must be a concise regeneration instruction.`,
          },
          { type: 'image', image: original },
          {
            type: 'text',
            text: 'The second image is the exact six-color dithered display preview. It must remain legible and compositionally strong.',
          },
          { type: 'image', image: displayPreview },
        ],
      },
    ],
    temperature: 0,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    providerOptions: { gateway: gatewayPrivacy },
  });
  return parseJson(result.text, qaSchema);
}
