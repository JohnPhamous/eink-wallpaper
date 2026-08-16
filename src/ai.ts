import { createGateway, generateText } from 'ai';
import { z } from 'zod';
import { getSecret } from './keychain.js';
import { loadMelloReferences } from './references.js';
import type { AppConfig, CreativeBrief, NarrativeContext, NormalizedEvent, QaResult, WeatherSnapshot } from './types.js';

const storySchema = z.object({
  editionKind: z.enum(['daily-chapter', 'sunday-tapestry']),
  worldLocationKey: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(1).max(80),
  worldLocationDescription: z.string().min(1).max(300),
  narrativeBeat: z.string().min(1).max(400),
  carriedMotifs: z.array(z.string().min(1).max(160)).max(3),
  weeklyEchoes: z.array(z.object({
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    eventTitle: z.string().min(1).max(240),
    cue: z.string().min(1).max(240),
  })).max(3).default([]),
  anniversaryEcho: z.object({
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    motif: z.string().min(1).max(200),
    reinterpretation: z.string().min(1).max(300),
  }).optional(),
});

const briefSchema = z.object({
  title: z.string().min(1).max(100),
  anchorEventIdHash: z.string().optional(),
  eventCues: z.array(z.object({
    eventIdHash: z.string().min(1),
    cue: z.string().min(1).max(240),
    prominence: z.enum(['primary', 'secondary']),
    visualGroup: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(1).max(80),
  })),
  anchorRationale: z.string().min(1).max(300),
  metaphor: z.string().min(1).max(300),
  setting: z.string().min(1).max(300),
  bichonAction: z.string().min(1).max(300),
  mood: z.string().min(1).max(300),
  lighting: z.string().min(1).max(300),
  palette: z.array(z.string()).min(3).max(8),
  weatherMotif: z.string().min(1).max(200),
  composition: z.string().min(1).max(300),
  visualPlan: z.object({
    focalHierarchy: z.string().min(1).max(300),
    camera: z.string().min(1).max(240),
    silhouetteAndGesture: z.string().min(1).max(300),
    depthAndScale: z.string().min(1).max(300),
    valueAndLighting: z.string().min(1).max(300),
    colorStrategy: z.string().min(1).max(300),
    eyePathAndNegativeSpace: z.string().min(1).max(300),
  }),
  scenePrompt: z.string().min(1).max(8000),
  avoid: z.array(z.string()).min(1).max(20),
  conceptKey: z.string().min(1).max(120),
  story: storySchema,
});

const qaSchema = z.object({
  pass: z.boolean(),
  reasons: z.array(z.string()).max(50),
  correction: z.string().max(2000),
  scores: z.object({
    focalHierarchy: z.number().min(1).max(10),
    compositionAndDepth: z.number().min(1).max(10),
    melloAppeal: z.number().min(1).max(10),
    calendarFidelity: z.number().min(1).max(10),
    originalityAndSpecificity: z.number().min(1).max(10),
    styleAndCraft: z.number().min(1).max(10),
    einkReadability: z.number().min(1).max(10),
  }),
});

const gatewayPrivacy = {
  zeroDataRetention: true,
  disallowPromptTraining: true,
} as const;

const MODEL_TIMEOUT_MS = 300_000;

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

function normalizeEventCue(eventTitle: string, cue: string): string {
  const fitness = /\b(gym|workout|training|weightlift|weightlifting|lift)\b/i.test(eventTitle);
  const sauna = /\bsauna\b/i.test(eventTitle);
  if (!fitness && !sauna) return cue;
  const normalized = fitness
    ? 'one full cobalt barbell with a straight shaft and two unmistakable pairs of large round weight plates'
    : cue;
  const representsSauna = /\b(sauna|bucket|ladle|steam room|wooden bench)\b/i.test(cue);
  const additions = [
    sauna && !representsSauna ? 'one wooden sauna bucket and ladle beside a slatted bench' : undefined,
  ].filter(Boolean);
  return additions.length > 0 ? `${normalized}; also show ${additions.join(' and ')}` : normalized;
}

function weeklyEchoCandidates(context?: NarrativeContext): Array<{ sourceDate: string; eventTitle: string; priorCue: string; prominence: 'primary' | 'secondary' }> {
  if (context?.editionKind !== 'sunday-tapestry') return [];
  const seen = new Set<string>();
  const candidates: Array<{ sourceDate: string; eventTitle: string; priorCue: string; prominence: 'primary' | 'secondary' }> = [];
  for (const memory of [...context.weeklyMemories].reverse()) {
    for (const eventCue of [...memory.eventCues].sort((a, b) => Number(b.prominence === 'primary') - Number(a.prominence === 'primary'))) {
      const key = eventCue.eventTitle.trim().toLocaleLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        sourceDate: memory.sourceDate,
        eventTitle: eventCue.eventTitle,
        priorCue: eventCue.cue,
        prominence: eventCue.prominence,
      });
    }
  }
  return candidates.slice(0, 12);
}

export async function createBrief(
  config: AppConfig,
  editionDate: string,
  events: NormalizedEvent[],
  weather: WeatherSnapshot,
  conceptHistory: Array<{ generatedAt: string; brief: CreativeBrief; rejected: boolean }>,
  newConcept: boolean,
  studyDirection?: string,
  narrativeContext?: NarrativeContext,
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
  const requiredCueEvents = [...events]
    .sort((a, b) => b.baseScore - a.baseScore || a.start.localeCompare(b.start));
  const weeklyCandidates = weeklyEchoCandidates(narrativeContext);
  const weeklyEchoBudget = narrativeContext?.editionKind === 'sunday-tapestry'
    ? Math.min(3, weeklyCandidates.length)
    : 0;
  const history = conceptHistory.slice(0, 30).map((entry) => ({
    date: entry.generatedAt.slice(0, 10),
    conceptKey: entry.brief.conceptKey,
    metaphor: entry.brief.metaphor,
    anchor: entry.brief.anchorEventIdHash,
    palette: entry.brief.palette,
    rejected: entry.rejected,
  }));
  const system = `You are the creative director for one text-free daily artwork on a six-color e-ink frame.
Return one strict JSON object and nothing else. Facts are sacred; visual metaphor is free.

Non-negotiable visual rules:
- Exactly one living character: a single white fluffy bichon dog. No people, animals, robots, creatures, faces in clouds, silhouettes, crowds, or background figures.
- The bichon is Mello, matching the supplied dog-only reference photos: a petite white bichon with a softly rounded but slightly oblong cloud of tight curls, low floppy cloud-like ears, a very short blunt button muzzle, a small rounded dark nose tucked close beneath the eyes rather than projecting forward, and close-set small dark oval-to-almond eyes partly tucked into the fur. Keep the eyes graphically simple—solid dark shapes with no visible iris/pupil layers and at most one pinprick highlight per eye. Make Mello unmistakably cheerful and cute through a small open smile, gently upturned mouth corners, and optionally a tiny pink tongue; never a neutral, worried, stern, or vacant expression, never a long snout, and never visible human-like teeth. His charm comes from his real petite proportions, fluffy silhouette, joyful expression, and lively pose, never giant glossy anime eyes. Use a compact cloud-like body, short legs, tiny rounded paws, and a subtle cobalt-blue collar with no harness, tracker disc, tag, or other costume. Roughly 2 heads long; clearly canine, never humanoid, baby-like, plush, or 3D-mascot-like.
- Keep the bichon fully visible at roughly 35-45% of frame height. Use restrained cobalt or deep-black separation only where its white fur would otherwise disappear; avoid mascot-like heavy outlining.
- Absolutely no readable text, letters, numbers, signage, logos, UI, calendars, clocks, captions, or watermarks.
- One full-bleed cinematic landscape scene, no panels, widgets, borders, picture frames, poster margins, boxes, insets, or vignettes.
- The world is visibly unoccupied except for the bichon. Never place figures or silhouettes inside windows, vehicles, reflections, distant architecture, or implied workplaces.
- Contemporary hand-drawn adventure-anime keyframe language: simplified expressive contours, reduced line density, elastic squash-and-stretch, dynamic foreshortening, strong motion arcs, and bold cel-shaped shadow/highlight masses. The bichon must read as a lively 2D drawing integrated into a dimensional painterly environment—not a photograph, realistic render, plush toy, or soft 3D animation still.
- Blend painterly environmental textures and subtle depth into broad graphic shapes. Use an asymmetrical cinematic camera and a decisive action pose. Sophisticated, warm, serene, lightly funny; never childish, mascot-like, or anxious. Do not reference or reproduce any existing franchise, character, costume, symbol, or setting.
- Compose centrally for a 16:9 source that will lose 3.125% from each side before becoming 5:3. Use strong silhouettes and broad color regions that survive six-color dithering.
- Make cobalt/ultramarine blue and emerald/leaf green the unmistakable dominant chromatic masses—roughly 70% of the colored area—supported by white and deep black. Restrict coral red and warm yellow to a few small focal accents, together under roughly 15% of the frame. Avoid beige, cream, lavender, gray, or brown dominance.
- Reserve soft blue-to-green gradients for limited sky, atmosphere, water, or reflection areas; preserve large saturated blue and green planes that survive the exact six-color conversion.
- Blend tactile dimensional materials inside those broad shapes. Avoid flat vector-mascot art, generic children's illustration, dense pavement seams, and tiny decorative detail.
- Use one dominant activity for composition, then account for every event in requiredEventCues. The list is authoritative, uncapped, and already reflects the user's calendar-name and title-prefix exclusions. Never omit an event because the day is busy. Anchor eligibility controls only which event may lead: tentative, optional, transparent, administrative, or unaccepted events still receive subordinate cues but can never become primary. Return one eventCues entry per input event, but assign each a concise visualGroup. Closely related events should share one visualGroup and one coherent visible motif: several 1:1s/interviews can become a conversation garden of paired cups, chairs, or connected phones; reviews/calibrations/design forums can become one studio-review cluster of paper prototypes, models, and drafting tools; related personal events can share one narrative action. A single visible group may satisfy every event assigned to it—do not create a separate prop per event merely to prove enumeration. Keep visual groups subordinate but recognizable after six-color conversion. Combine all groups into one physical story rather than panels, a collage, or an evenly weighted inventory. Every Gym, workout, training, lifting, or weightlifting event must belong to a fitness visualGroup represented by a full barbell with a straight shaft and clearly visible weight plates at both ends—never a kettlebell, dumbbell, yoga mat, resistance band, or generic block. A compound “Gym + Sauna” group needs both that barbell and a wooden sauna bucket or ladle. Keep every prop bold, simple, factual, and unlabeled. No ornate machinery, gears, dials, tick marks, clock faces, segmented decorative platforms, or intricate floral constructions.
- Translate work concepts into concrete, ordinary studio or conversation objects integrated into the environment: an unlabeled sketchbook, colored paper prototype, small physical model, drafting tool, two connected tin-can telephones, two empty cups, or two empty seats. Pick cues specific to the event rather than generic office symbolism. Never use desks, consoles, screens, dashboards, office interiors, holograms, wireframes, node networks, technical diagrams, floating UI, grids, giant abstract blocks, balancing monoliths, or intricate geometric clusters.
- Keep the bichon physically active in the environment—running, leaping, climbing, carrying, digging, balancing, or exploring. Simple ordinary event objects may drive the action, but never pose the dog working at desks, screens, consoles, vehicles, or complex human machinery.
- Favor a closer cinematic tableau with the bichon actively carrying, nudging, arranging, opening, investigating, or moving toward the primary event object. Preserve enough environmental breathing room for weather, place, and mood.

Art-direction rules—the image must be designed, not merely decorated:
- Establish a ruthless three-level hierarchy: the first read is Mello performing the primary activity; the second read is the primary event object/action; the third read is weather, place, and secondary event cues. Never give every prop equal size, contrast, saturation, or detail.
- Make Mello and the primary action one connected hero shape occupying roughly 35-45% of frame height. Place that hero off-center near a thirds intersection. Keep a clean patch of contrasting negative space around Mello's face and silhouette; avoid tangencies where ears, paws, nose, or event props merge with horizon lines or busy edges.
- Choose one intentional cinematic camera—low three-quarter, high oblique, near-ground wide, or close environmental wide—and state it precisely. Avoid flat eye-level staging, straight-on catalog views, centered symmetry, or a horizon bisecting the image.
- Build a clear foreground, middle ground, and background using overlap, relative scale, and atmospheric simplification. Use one bold foreground shape to frame or lead into the action; keep the background quieter, lower-detail, and subordinate.
- Organize the picture into three to five large interlocking value/color masses that read at thumbnail size and after six-color conversion. Put the strongest light-dark or complementary-color contrast at Mello's face and primary action. Do not scatter equal contrast across the frame.
- Create a deliberate eye path using one dominant diagonal, S-curve, arc, shoreline, shadow, wake, branch, or architectural edge. It must lead into Mello, continue through the primary cue, then briefly reveal secondary cues without becoming a diagram.
- Use a decisive line of action, asymmetrical balance, varied scale, controlled overlap, and visible motion consequence in the environment. Prefer a captured before-or-after instant over a static pose.
- Treat color as structure: one dominant cool family, one supporting cool family, and a tiny warm accent concentrated near the focal action. Use white fur as a luminous focal mass separated by cobalt/deep-black edges and nearby saturated color—not as empty paper.
- Use directional, motivated light with broad cel-shadow shapes. Reserve the sharpest edges and richest material texture for the focal zone; simplify edges, marks, and texture with distance. Avoid uniform lighting, uniform sharpness, and detail everywhere.
- The result should feel surprising yet inevitable: one bold compositional idea, not many competing tricks. If a cue cannot be integrated without clutter, simplify its form and scale rather than weakening the hero read.

Story-world rules:
- This is one chapter in a year-long story about the same bichon. The archive context is canon, not a request to copy yesterday’s composition.
- Choose a setting from today’s factual event locations, travel context, and weather. If the inputs indicate travel, let the actual destination or journey determine the setting. Never invent a city, venue, trip, or destination.
- Give the setting a concise lowercase kebab-case worldLocationKey and a concrete worldLocationDescription. Reuse a prior key when returning to substantially the same place; create a new key when the factual setting or travel context genuinely moves the story elsewhere. The location history is precedent, not a closed atlas.
- When previousChapter exists, carry one or two simple visual motifs forward and evolve them. Keep continuity subtle: a familiar prop, plant, weather shape, material, path, or environmental feature—not a second character, text, emblem, or decorative clutter.
- narrativeBeat states what changed for the bichon today. It must follow naturally from the prior chapter without claiming real-world feelings, accomplishments, or actions not present in the inputs.
- For a sunday-tapestry, the current day remains coherent but the scene also recalls the preceding Monday through Saturday. Select exactly weeklyEchoBudget entries from weeklyEchoCandidates, prioritizing primary, unusual, and visually distinctive events. Copy each selected sourceDate and eventTitle exactly. Each chosen echo must be a bold recognizable object in the same scene, never a panel, collage, label, timeline, or miniature inset.
- On ordinary daily chapters weeklyEchoes must be empty.
- If anniversary is present, anniversaryEcho is required. Reinterpret one visible motif from that prior-year edition in a changed form; do not simply reproduce the old composition. If anniversary is absent, omit anniversaryEcho.
- carriedMotifs contains at most three concrete visual motifs that future chapters can recognize. Do not put calendar titles or private names in carriedMotifs.

Editorial rules:
- Personal significance outranks work; nonroutine outranks recurring; visual distinctiveness may override.
- The application has enforced personal-first anchoring, but requiredEventCues contains every remaining personal and work event, including events that are context-only for anchor selection. Work must be visible without competing with the personal anchor.
- OOO, travel, conferences, launches, and milestones outrank ordinary meetings.
- Tentative, optional, free, or unaccepted events may influence atmosphere but can never anchor.
- Recurring events are eligible but receive a novelty penalty. Gym may anchor at most once per rolling 7 days. The same recurring work series may anchor at most once per rolling 30 days.
- Related events may become one honest theme. If nothing is visually meaningful, create a Seattle-weather-led bichon adventure.
- Ordinary weather changes only sky, light, wind, and ground conditions. Notable weather may become a stronger motif. A severe official alert overrides the calendar anchor.
- The primary event must be recognizable at a glance through a literal activity, setting, or ordinary event-specific object. Symbolism may enrich the scene but can never replace this concrete cue. Avoid generic glowing seeds, orbs, stones, portals, alignment rituals, mountain quests, unexplained smoke, and other visual metaphors that obscure the calendar meaning.
- Prefer objects specific enough to distinguish the event: a baby shower needs a tiny pair of baby booties, rattle, folded baby blanket, or similar cue alongside any gift; a medical checkup needs a recognizable unlabeled medical object; weightlifting needs a full plated barbell. A generic gift, bag, bowl, sphere, geometric block, or landscape alone is insufficient when the event type offers a clearer ordinary object.
- Every requiredEventCues entry must appear in eventCues with the same event ID, a concrete cue, and a visualGroup. Every unique visualGroup must be explicitly implemented once in scenePrompt, and every event assigned to that group is then accounted for. When eligibleAnchorCandidates is nonempty, choose exactly one eligible primary cue unless severe weather is the primary subject; mark every other event secondary. When no event is anchor-eligible, keep every event secondary. Never put an object needed by an event group into avoid.
- Freely invent composition, environment, motion, and visual relationships between factual objects. Never invent an obligation, person, destination, relationship, object implication, or weather condition.
- Avoid repeating recent complete concepts, compositions, and palettes. Recurring story locations and explicitly carried motifs are intentional exceptions. ${newConcept ? 'The user explicitly requested a substantially new concept and eligible anchor where possible, while preserving story continuity.' : ''}

${studyDirection ? `Aesthetic-study override—follow this while preserving the factual, privacy, single-character, no-text, and no-franchise rules:\n${studyDirection}` : ''}

Required JSON keys: title, anchorEventIdHash (optional), eventCues (uncapped array of eventIdHash, cue, prominence, visualGroup), anchorRationale, metaphor, setting, bichonAction, mood, lighting, palette (3-8 plain color names), weatherMotif, composition, visualPlan, scenePrompt, avoid (array), conceptKey, story. Return exactly one eventCues item for every requiredEventCues input, regardless of count; grouping reduces visible motifs, never the returned event list. visualPlan must contain focalHierarchy, camera, silhouetteAndGesture, depthAndScale, valueAndLighting, colorStrategy, and eyePathAndNegativeSpace. Each visualPlan field must name concrete placements, relative sizes, shapes, directions, or contrasts for this exact scene—never generic praise such as beautiful, cinematic, masterpiece, detailed, or dynamic. story must contain editionKind, worldLocationKey, worldLocationDescription, narrativeBeat, carriedMotifs, weeklyEchoes, and anniversaryEcho only when applicable. List cobalt/ultramarine blue and emerald/leaf green first in palette. The scenePrompt must be a complete production prompt ordered as subject/action, setting, composition/camera, depth/scale, light/value, color, and medium. It must implement every unique visualGroup, every selected weekly or anniversary echo, the chosen recurring location, all seven visualPlan decisions, and every visual rule, including Mello’s compact reference-faithful face and simple small eyes, the close full-bleed tableau, fluid cel-and-gouache treatment, and blue-green color hierarchy.`;
  const input = {
    editionDate,
    timezone: config.timezone,
    weather,
    eligibleAnchorCandidates: safeEvents(eligible),
    requiredEventCues: safeEvents(requiredCueEvents),
    contextOnlyEvents: [],
    recentConceptsToAvoid: history,
    storyContext: narrativeContext ? {
      editionKind: narrativeContext.editionKind,
      previousChapter: narrativeContext.previousChapter,
      recurringLocationHistory: narrativeContext.locationHistory,
      recentMotifs: narrativeContext.recentMotifs,
      weeklyEchoCandidates: weeklyCandidates,
      weeklyEchoBudget,
      anniversary: narrativeContext.anniversary,
    } : {
      editionKind: 'daily-chapter',
      weeklyEchoCandidates: [],
      weeklyEchoBudget: 0,
    },
  };
  const requiredCueIds = new Set(requiredCueEvents.map((event) => event.idHash));
  const eventById = new Map(requiredCueEvents.map((event) => [event.idHash, event]));
  let correction: string | undefined;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await generateText({
      model: gateway(config.models.brief),
      system,
      prompt: `${JSON.stringify(input)}${correction ? `\nCorrect the prior invalid response: ${correction}` : ''}`,
      temperature: 0.8,
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      providerOptions: { gateway: gatewayPrivacy },
    });
    try {
      const generated = parseJson(result.text, briefSchema);
      if (generated.anchorEventIdHash && !eligible.some((event) => event.idHash === generated.anchorEventIdHash)) {
        throw new Error('Creative director selected an ineligible or nonexistent anchor event');
      }
      const returnedCueIds = new Set(generated.eventCues.map((cue) => cue.eventIdHash));
      if (requiredCueIds.size !== returnedCueIds.size || [...requiredCueIds].some((id) => !returnedCueIds.has(id))) {
        throw new Error('Creative director omitted or invented a required calendar cue');
      }
      const primaryCues = generated.eventCues.filter((cue) => cue.prominence === 'primary');
      if (!weather.severe && eligible.length > 0 && (primaryCues.length !== 1 || primaryCues[0].eventIdHash !== generated.anchorEventIdHash)) {
        throw new Error('Creative director did not align the primary cue with the calendar anchor');
      }
      if (!weather.severe && eligible.length === 0 && (generated.anchorEventIdHash || primaryCues.length > 0)) {
        throw new Error('Creative director selected a primary event when none is anchor-eligible');
      }
      const eventCues = generated.eventCues.map((cue) => {
        const event = eventById.get(cue.eventIdHash);
        if (!event) throw new Error('Creative director invented a calendar cue');
        const normalizedCue = normalizeEventCue(event.title, cue.cue);
        if (event.account === 'work' && /\b(abstract|geometric|block|cube|monolith|orb|portal|platform|pedestal)\b/i.test(normalizedCue)) {
          throw new Error(`Work cue for ${event.title} is generic geometry; use a concrete ordinary studio or conversation object`);
        }
        return { ...cue, cue: normalizedCue, eventTitle: event.title };
      });
      const expectedKind = narrativeContext?.editionKind ?? 'daily-chapter';
      if (generated.story.editionKind !== expectedKind) throw new Error('Creative director used the wrong story edition type');
      if (generated.story.weeklyEchoes.length !== weeklyEchoBudget) {
        throw new Error(`Creative director must select exactly ${weeklyEchoBudget} weekly echo(s)`);
      }
      const weeklyKeys = new Set(weeklyCandidates.map((candidate) => `${candidate.sourceDate}\u0000${candidate.eventTitle}`));
      const returnedWeeklyKeys = new Set<string>();
      for (const echo of generated.story.weeklyEchoes) {
        const key = `${echo.sourceDate}\u0000${echo.eventTitle}`;
        if (!weeklyKeys.has(key) || returnedWeeklyKeys.has(key)) throw new Error('Creative director invented or duplicated a weekly echo');
        returnedWeeklyKeys.add(key);
      }
      if (narrativeContext?.anniversary) {
        if (generated.story.anniversaryEcho?.sourceDate !== narrativeContext.anniversary.sourceDate) {
          throw new Error('Creative director omitted or changed the anniversary source');
        }
      } else if (generated.story.anniversaryEcho) {
        throw new Error('Creative director invented an anniversary echo');
      }
      if (narrativeContext?.previousChapter && generated.story.carriedMotifs.length === 0) {
        throw new Error('Creative director failed to carry a visual motif from the prior chapter');
      }
      return { ...generated, eventCues };
    } catch (error) {
      if (attempt === 5) throw error;
      correction = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error('Creative director failed to create a valid brief');
}

export async function generateArtwork(
  config: AppConfig,
  brief: CreativeBrief,
  correction?: string,
  aestheticDirection?: string,
): Promise<{ bytes: Buffer; mediaType: string }> {
  const gateway = await prepareGateway();
  const melloReferences = await loadMelloReferences();
  const prompt = `${brief.scenePrompt}

ART-DIRECTION BLUEPRINT—treat every field as a binding spatial instruction:
${JSON.stringify(brief.visualPlan ?? {
  focalHierarchy: 'Mello performing the primary activity is the unmistakable first read; the primary cue is second; all other information is subordinate.',
  camera: brief.composition,
  silhouetteAndGesture: 'A clean, fully visible Mello silhouette with a decisive line of action and no edge tangencies.',
  depthAndScale: 'Three distinct overlapping depth planes with decreasing scale and detail.',
  valueAndLighting: brief.lighting,
  colorStrategy: brief.palette.join(', '),
  eyePathAndNegativeSpace: 'One dominant directional path leads to Mello; preserve quiet negative space around his face.',
})}

Composition lock: create one immediately legible hero read, not an evenly weighted inventory. Mello plus the primary action must form one connected off-center hero shape at 35-45% of frame height, near a thirds intersection, surrounded by clean contrasting negative space. Use one dominant diagonal, arc, or S-curve to pull the eye into Mello, through the primary cue, and only then toward secondary cues. Build distinct foreground, middle ground, and background with overlap and relative scale. Organize the image into three to five broad interlocking value/color masses; concentrate the sharpest edges, greatest value contrast, strongest hue contrast, and richest texture at Mello's face and primary action. Keep secondary props smaller, simpler, less contrasted, and physically integrated. Avoid centered symmetry, a bisecting horizon, flat eye-level staging, equal-sized props, scattered focal points, accidental tangencies, uniform detail, and empty scenic distance.

Style lock: a fluid hand-drawn 2D adventure-animation keyframe with broad gouache color masses, never photorealistic and never a 3D render. Use simplified expressive contours, reduced line density, elastic motion, dynamic foreshortening, cel-shaped light and shadow, pastel-futuristic atmosphere, and painterly dimensional environmental textures. The single dog is Mello from the dog-only references: petite white bichon, softly rounded slightly oblong curly head, low floppy ears, very short blunt button muzzle, small rounded dark nose sitting close beneath the eyes without a projecting snout, and small close-set dark oval-to-almond eyes partly tucked into his fur. Render each eye as one simple dark shape with no iris/pupil rings and zero or one pinprick highlight—not large, glassy, sparkling, layered, or doll-like. Give him a clearly joyful small open smile with gently upturned corners and optionally a tiny tongue, without human-like teeth. Keep his compact cloud-like body, short legs, tiny paws, subtle cobalt collar, and roughly two-heads-long chibi proportions while remaining recognizably Mello and clearly canine. Ignore any tracker disc or harness visible in a reference. Mello must remain a quadrupedal dog: he may leap, rear briefly, balance a paw, roll, nudge, or vault over the barbell, but never stand planted on two legs holding or lifting it like a human athlete. Every eventCues item must remain visibly recognizable, with secondary cues integrated as simple subordinate props in the same physical scene. Any fitness cue must be a full plated barbell, never a kettlebell, dumbbell, mat, band, or abstract block. Preserve scenic breathing room. Cobalt/ultramarine blue and emerald/leaf green must dominate the colored area; red and yellow are sparse focal accents only.

Required calendar cues: ${JSON.stringify(brief.eventCues ?? [])}
Story continuity: ${JSON.stringify(brief.story ?? {})}

Render the chosen recurring location, carried motifs, weekly echoes, and anniversary reinterpretation literally enough to survive the six-color conversion. They must remain parts of one cinematic environment, never a collage, timeline, panel layout, labeled recap, or collection of inset scenes.

${aestheticDirection ? `Aesthetic study direction: ${aestheticDirection}\nThis direction overrides the generic medium and mark-making choices in the style lock, but never the subject, factual, composition-safe-area, palette-hierarchy, or hard-exclusion rules.` : ''}

Hard exclusions: ${[...brief.avoid, 'photorealism', 'realistic photography', '3D-rendered character', 'plush-toy appearance', 'soft CGI animation still', 'all text', 'all logos', 'every other character', 'cropped bichon', 'decorative border', 'picture frame', 'poster margin', 'panel', 'inset image', 'vignette', 'abstract glowing orb', 'generic symbolic stone', 'unexplained smoke'].join('; ')}.
Output one polished 16:9 landscape artwork. Keep the bichon and essential action inside the central 90% width safe area.
${correction ? `Mandatory correction—this overrides any conflicting object, palette, or composition instruction earlier in the prompt: ${correction}` : ''}`;

  if (config.models.image.startsWith('google/')) {
    const result = await generateText({
      model: gateway(config.models.image),
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${prompt}\n\nThe following ${melloReferences.length} images are dog-only identity references for Mello. Preserve his facial proportions, small eye size and placement, very short blunt muzzle, nose placement close beneath the eyes, low ears, curl silhouette, and petite build while translating him into the requested 2D cel-and-gouache style. Make his expression more cheerful than the neutral reference moments: a cute small open smile with gently upturned corners and optionally a tiny tongue. Do not lengthen the snout, add human-like teeth, or reproduce reference backgrounds.`,
          },
          ...melloReferences.map((reference) => ({
            type: 'image' as const,
            image: reference.bytes,
            mediaType: reference.mediaType,
          })),
        ],
      }],
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      providerOptions: {
        gateway: gatewayPrivacy,
        google: {
          responseModalities: ['IMAGE'],
          imageConfig: { aspectRatio: '16:9', imageSize: config.models.imageSize },
          thinkingConfig: { thinkingLevel: 'high' },
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
  const melloReferences = await loadMelloReferences();
  const result = await generateText({
    model: gateway(config.models.qa),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Inspect this candidate as a demanding animation art director and gallery juror. Return strict JSON only: {"pass":boolean,"reasons":string[],"correction":string,"scores":{"focalHierarchy":number,"compositionAndDepth":number,"melloAppeal":number,"calendarFidelity":number,"originalityAndSpecificity":number,"styleAndCraft":number,"einkReadability":number}}. Score every dimension from 1-10. Calibrate harshly: 5 is competent but generic, 6 is presentable, 7 is good with visible weaknesses, 8 is excellent, 9 is portfolio-worthy and memorable, and 10 is exceptionally rare. The first ${melloReferences.length} image(s) are dog-only identity references for Mello; they are evidence, not candidate artwork. The image immediately after those references is the full-color candidate, and the final image is its exact six-color display preview.
${brief ? `Validate semantic fidelity against this private creative brief: ${JSON.stringify({ eventCues: brief.eventCues ?? [], story: brief.story, anchorRationale: brief.anchorRationale, setting: brief.setting, bichonAction: brief.bichonAction, weatherMotif: brief.weatherMotif, composition: brief.composition, visualPlan: brief.visualPlan, scenePrompt: brief.scenePrompt })}` : ''}
Reject if: the single white fluffy bichon is absent or badly cropped; the dog does not resemble Mello’s supplied references; the face uses oversized glossy anime eyes, layered irises or pupils, multiple reflections, star highlights, or doll-like eye detail instead of Mello’s small simple dark oval-to-almond eyes partly tucked into fur; the muzzle projects into a long snout, the nose sits too far forward, Mello lacks a clearly cheerful cute smile, or his expression is neutral, worried, stern, or vacant; the low floppy ears, compact build, or curly silhouette materially drift from Mello; a harness or tracker disc is copied from the references instead of the requested subtle collar; Mello stands planted upright on two legs or lifts the barbell like a human athlete instead of behaving as a lively quadrupedal dog; a fitness event uses a kettlebell, dumbbell, mat, resistance band, abstract block, or anything other than a clearly recognizable full barbell with weight plates at both ends; a work event is represented by generic geometry, giant blocks, monoliths, or balancing platforms instead of concrete ordinary objects; any other living character, person, animal, robot, creature, silhouette, or face appears; any readable text, letters, numbers, signage, logo, UI, caption, or watermark appears; any decorative border, inset picture frame, panel, timeline, recap layout, or boxed composition appears; severe anatomy errors; childish tone; recognizable franchise imagery; photorealistic treatment; realistic photography; a plush-toy or soft 3D-rendered bichon; insufficient fluid hand-drawn cel-and-gouache character; an anchored calendar event is replaced by an unreadable abstract metaphor instead of a recognizable activity, setting, or ordinary object; any eventCues item is absent or not recognizable in either the source or six-color preview; any requested weekly echo is absent or unrecognizable; an anniversary reinterpretation is requested but has no visible visual echo; the chosen recurring location contradicts its description; the image contradicts the supplied brief; blue and green are not the clearly dominant chromatic masses; red/yellow overwhelm the blue-green hierarchy; or the overall scene becomes illegible in the exact black/white/green/blue/red/yellow palette.

Also reject a merely adequate composition when any major art-direction failure is visible in the six-color preview: Mello and the primary action are not the unmistakable first read; Mello is too small to carry the image; the frame is centered, static, flat, or evenly weighted; secondary groups compete with the hero; the image creates one isolated prop per calendar event instead of coherently grouping related events; any unique visualGroup in the brief is absent or unrecognizable; no clear directional eye path leads into the focal action; the silhouette is lost through tangencies or background noise; foreground, middle ground, and background do not separate through overlap and scale; value/color shapes fragment into clutter instead of three to five broad masses; contrast and detail are scattered rather than concentrated at the focal zone; or the image lacks a decisive line of action and captured-moment energy. Judge the actual result, not whether the prompt used art vocabulary.

Every eventCues item must map an input event into a visualGroup, and every unique visualGroup plus every selected weekly echo must be visible even when secondary. Multiple events sharing one visible group are intentionally satisfied together and must not be rejected for lacking separate duplicate props. Minor painterly ambiguity and small accent-hue shifts are acceptable. Do not reject solely because a sparse red or yellow accent darkens, shifts hue, or disappears after dithering when the subject, action, and blue-green composition remain clear. ${studyAcceptance ?? ''} Set pass=true only if every score is at least 9 and the average is at least 9; a pleasant, technically correct, familiar, or generic image must fail. The correction must name every missing or ambiguous visual group, story echo, Mello-identity issue, or major art-direction failure and give a concise regeneration instruction prioritizing the hero read.`,
          },
          ...melloReferences.map((reference) => ({ type: 'image' as const, image: reference.bytes, mediaType: reference.mediaType })),
          {
            type: 'text',
            text: 'The next image is the generated full-color candidate to inspect.',
          },
          { type: 'image', image: original },
          {
            type: 'text',
            text: 'The final image is the exact six-color dithered display preview. It must remain legible and compositionally strong.',
          },
          { type: 'image', image: displayPreview },
        ],
      },
    ],
    temperature: 0,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    providerOptions: { gateway: gatewayPrivacy },
  });
  const assessment = parseJson(result.text, qaSchema);
  const scoreValues = Object.values(assessment.scores);
  const average = scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length;
  const pass = assessment.pass && Math.min(...scoreValues) >= 9 && average >= 9;
  const weakDimensions = Object.entries(assessment.scores)
    .filter(([, score]) => score < 9)
    .map(([dimension, score]) => `${dimension} ${score}/10`);
  const thresholdReason = `Art-direction threshold missed${weakDimensions.length ? `: ${weakDimensions.join(', ')}` : `: average ${average.toFixed(2)}/10`}`;
  return {
    ...assessment,
    pass,
    reasons: pass ? [] : assessment.reasons.length > 0 ? assessment.reasons : [thresholdReason],
    correction: pass ? '' : assessment.correction || `Regenerate with a stronger, more specific hero composition. Fix ${weakDimensions.join(', ') || `the ${average.toFixed(2)}/10 average`} while preserving every calendar cue.`,
    scores: { ...assessment.scores, average: Math.round(average * 100) / 100 },
  };
}
