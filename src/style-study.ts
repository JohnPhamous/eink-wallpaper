import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createBrief, generateArtwork, inspectArtwork } from './ai.js';
import { recentBriefs } from './archive.js';
import { fetchTodayEvents } from './calendar.js';
import { atomicWrite, ensureDirectory } from './fs.js';
import { paths } from './paths.js';
import { renderArtwork } from './render.js';
import { midnightUtc, nextDateKey, todayBounds } from './time.js';
import type { AppConfig, CreativeBrief, QaResult } from './types.js';
import { fetchWeather } from './weather.js';

interface StyleDirection {
  id: string;
  label: string;
  direction: string;
}

const ROUND_ONE_STYLES: StyleDirection[] = [
  {
    id: 'fluid-cel-gouache',
    label: 'Fluid cel + gouache',
    direction: 'A fluid hand-drawn animation keyframe with very low line density, elastic gesture, broad gouache color masses, soft pastel-futuristic atmospheric gradients, and selectively dimensional painted surfaces. Elegant cinematic animation energy; loose but controlled; the closest direction to the current target.',
  },
  {
    id: 'ink-wash-minimal',
    label: 'Ink-wash minimalism',
    direction: 'A spare sumi-e and watercolor animation keyframe: expressive dry-brush contours, generous negative space, translucent cobalt and emerald washes, a few decisive black marks, and motion implied through brush rhythm. Sophisticated editorial restraint, not a children’s-book treatment.',
  },
  {
    id: 'graphic-screenprint',
    label: 'Graphic screenprint',
    direction: 'A bold hand-pulled screenprint and risograph-inspired animation frame: chunky interlocking silhouettes, intentionally imperfect registration, limited flat ink layers, sparse halftone texture, and a striking poster-like camera angle. Preserve organic motion and environmental depth without gradients or tiny detail.',
  },
  {
    id: 'layered-painted-paper',
    label: 'Layered painted paper',
    direction: 'A tactile layered painted-paper animation frame: torn and cut gouache shapes, visible paper fibers, shallow dimensional overlap, soft cast-edge depth, and sweeping curved layers that carry motion through the landscape. Sophisticated gallery-collage materiality, never cute craft or 3D CGI.',
  },
];

const ROUND_TWO_STYLES: StyleDirection[] = [
  {
    id: 'chibi-literal-centerpiece',
    label: 'Chibi · literal centerpiece',
    direction: 'Keep the fluid cel-and-gouache medium. Use an irresistibly cute chibi bichon with a large round fluffy head, compact cloud-like body, short legs, oversized dark expressive eyes, tiny nose and mouth, puffy ears, and a joyful canine expression; roughly 2.25 heads long, always clearly a quadruped. Make one recognizable calendar-specific object the visual centerpiece and show the bichon actively using, arranging, carrying, or investigating it. The event meaning should read immediately without text. Full-bleed scene only; no borders, panels, frames, or poster margins.',
  },
  {
    id: 'chibi-event-setting',
    label: 'Chibi · event setting',
    direction: 'Keep the fluid cel-and-gouache medium. Draw a charming chibi bichon with a very fluffy oversized head, tiny rounded paws, compact body, big dark eyes, small muzzle, and lively canine motion; roughly 2.25 heads long, never humanoid. Make the environment itself a recognizable version of the primary calendar activity or destination, with the dog naturally exploring it. Prefer concrete event cues over symbolism. Full-bleed cinematic environment; no borders, panels, frames, or inset images.',
  },
  {
    id: 'chibi-day-tableau',
    label: 'Chibi · day tableau',
    direction: 'Keep the fluid cel-and-gouache medium. Use a cute premium-animation chibi bichon: round cloud-like head, compact springy body, short legs, huge expressive dark eyes, subtle cobalt collar, and an active quadruped pose. Build one coherent landscape tableau with the primary calendar event stated through a prominent literal activity or prop and one or two secondary calendar cues integrated naturally into the scene. It must feel like this specific day, not generic adventure symbolism. No divisions, borders, boxes, labels, or panels.',
  },
  {
    id: 'chibi-cinematic-close',
    label: 'Chibi · cinematic action',
    direction: 'Keep the fluid cel-and-gouache medium but move the camera closer. Feature a highly appealing chibi bichon with a large fluffy head, compact body, tiny paws, big sparkling dark eyes, soft round muzzle, and elastic canine expression; roughly 2 heads long, still fully visible and quadrupedal. Stage a decisive, readable interaction with a literal calendar-specific object or activity in the foreground, supported by a recognizable event setting. Avoid vague glowing nature metaphors. No border, frame, panel, poster margin, or vignette.',
  },
];

const ROUND_TWO_BRIEF_DIRECTION = `The prior artwork was too abstract. Ground the image much more directly in the calendar data.
- The primary event must be recognizable at a glance from a literal activity, setting, or ordinary event-specific object—not a generic natural metaphor such as a glowing seed, orb, resonant stone, portal, mountain quest, or symbolic landscape.
- If useful, integrate one or two secondary events as subtle but recognizable objects or environmental cues so the artwork feels like the whole day, not merely one vague concept.
- Simple everyday objects, furnishings, gifts, celebration items, sports objects, travel items, or medical-checkup objects are allowed when factually tied to an event. Keep them unlabeled and do not invent branded or textual details.
- Make the single bichon notably cuter with chibi proportions: oversized round fluffy head, compact body, short legs, large expressive dark eyes, tiny nose and mouth, puffy ears, and a cloud-like silhouette. It must remain a four-legged canine with lively animation motion, not a human, baby, plush toy, or 3D mascot.
- Retain fluid cel animation, broad gouache masses, reduced line density, pastel-futuristic light, and dimensional painted environments.
- Use a full-bleed composition with absolutely no border, poster margin, inset frame, panel, box, or vignette.`;

const ROUND_TWO_QA = 'Chibi canine proportions are explicitly requested and should not be rejected as childish when the rendering remains sophisticated. Reject if the calendar grounding is merely an abstract glowing seed, orb, stone, portal, generic mountain quest, or other unreadable metaphor instead of a recognizable event activity, setting, or object.';

const ROUND_THREE_STYLES: StyleDirection[] = [
  {
    id: 'hybrid-balanced-tableau',
    label: 'Hybrid · balanced tableau',
    direction: 'Use the selected hybrid: fluid cel-and-gouache animation, the compact ultra-cute chibi bichon design, and two or three literal calendar cues in one coherent scene. Compose a balanced medium-wide tableau with the fully visible dog at roughly 30% of frame height. The dog actively interacts with the primary event object; secondary event objects remain clearly recognizable but subordinate. Preserve generous environmental beauty and motion. Full bleed with no border, panel, frame, poster margin, or vignette.',
  },
  {
    id: 'hybrid-close-tableau',
    label: 'Hybrid · closer tableau',
    direction: 'Use the selected hybrid: fluid cel-and-gouache animation, a round-headed compact chibi bichon, and two or three literal calendar cues. Use a closer cinematic camera with the fully visible dog around 35% of frame height, huge dark expressive eyes, tiny muzzle and paws, and an appealing active canine pose. Make the primary event interaction instantly readable; arrange secondary cues deeper in the same environment. Full bleed only; no border, inset, box, or vignette.',
  },
  {
    id: 'hybrid-playful-props',
    label: 'Hybrid · playful prop story',
    direction: 'Use the selected hybrid: fluid cel-and-gouache animation and the cutest compact chibi bichon. Build a playful physical story in which the quadruped dog carries, nudges, unwraps, arranges, or investigates recognizable calendar-specific objects. Use strong squash-and-stretch and a decisive motion arc while keeping every object ordinary, literal, and easy to identify. Include at most three event cues in one natural setting. Full bleed; absolutely no framing device, decorative border, panel, poster margin, or vignette.',
  },
  {
    id: 'hybrid-scenic-world',
    label: 'Hybrid · scenic event world',
    direction: 'Use the selected hybrid: highly appealing chibi bichon animation embedded in a beautiful dimensional gouache environment. Let the setting evoke the primary event while keeping two or three literal event-specific objects large and unmistakable in the foreground or middle ground. The dog remains the emotional focus and actively connects the objects into one story. Keep the image cinematic, airy, and sophisticated rather than cluttered. Full bleed with no border, frame, panel, box, margin, or vignette.',
  },
];

const ROUND_THREE_BRIEF_DIRECTION = `This is a narrowing round. Combine the prior best calendar-rich day tableau with the prior cutest cinematic chibi dog.
- Represent the day with two or three concrete, immediately recognizable calendar cues integrated into one coherent full-bleed scene. The primary event must dominate; secondary events remain subordinate.
- For a baby shower, require unmistakable ordinary objects such as a wrapped gift with bow plus tiny baby booties, a rattle, folded baby blanket, or a few balloons. A plain basket or blanket alone is insufficient. Never depict a baby, person, face, name, text, or signage.
- For a medical checkup, require unmistakable unlabeled medical objects such as a stethoscope, height measure, simple medical bag, or examination surface. A smooth sphere, stone, mountain alignment, or vague wellness metaphor is forbidden.
- A workout may appear secondarily through one simple kettlebell, dumbbell, mat, or resistance band, never as the primary event when a personal medical appointment is present.
- Weather affects sky, light, wind, and ground conditions only. Do not render generic smoke, magical glow, portals, floating seeds, or unexplained atmospheric plumes.
- The bichon must use the chosen cute design: oversized round fluffy head, compact cloud-like body, short legs, tiny rounded paws, huge dark expressive eyes, tiny nose and soft muzzle, puffy ears, and subtle cobalt collar. Roughly 2 heads long, fully visible, clearly canine and quadrupedal except for a brief physically motivated upright action.
- Retain reduced-line fluid cel animation, broad gouache color masses, pastel-futuristic atmospheric light, and dimensional painted environmental textures.
- Absolutely no border, picture frame, poster margin, panel, inset, box, vignette, labels, icons, logos, or readable marks.`;

const ROUND_THREE_QA = 'This round explicitly requires the cute compact chibi dog plus two or three literal calendar cues matching the supplied brief. Reject if the primary event is not recognizable from ordinary activity, setting, or objects; if secondary objects contradict the brief; or if fewer than two concrete calendar cues appear when the brief supports them. Reject generic smoke, magical glow, portals, floating seeds, unexplained plumes, abstract stones or spheres, and plain baskets standing in for an event.';

interface StudyVariant {
  index: number;
  date: string;
  dayLabel: string;
  styleId: string;
  styleLabel: string;
  directory: string;
  brief: CreativeBrief;
  qa: QaResult;
  attempts: number;
}

function nextMonday(date: string): string {
  let candidate = nextDateKey(date);
  while (new Date(`${candidate}T12:00:00Z`).getUTCDay() !== 1) candidate = nextDateKey(candidate);
  return candidate;
}

function dateAtNoon(date: string, timezone: string): Date {
  return new Date(midnightUtc(date, timezone).getTime() + 12 * 60 * 60 * 1000);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

async function contactSheet(
  root: string,
  file: string,
  dates: Array<{ date: string; label: string }>,
  variants: StudyVariant[],
  styles: StyleDirection[],
): Promise<void> {
  const tileWidth = 800;
  const imageHeight = 480;
  const labelHeight = 54;
  const headerHeight = 70;
  const rowHeight = imageHeight + labelHeight;
  const width = tileWidth * dates.length;
  const height = headerHeight + rowHeight * styles.length;
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];

  for (let column = 0; column < dates.length; column += 1) {
    const header = Buffer.from(`<svg width="${tileWidth}" height="${headerHeight}"><rect width="100%" height="100%" fill="#111"/><text x="24" y="44" font-family="-apple-system,Helvetica,sans-serif" font-size="26" font-weight="700" fill="white">${escapeHtml(dates[column].label)} · ${dates[column].date}</text></svg>`);
    composites.push({ input: header, left: column * tileWidth, top: 0 });
  }

  for (let row = 0; row < styles.length; row += 1) {
    for (let column = 0; column < dates.length; column += 1) {
      const variant = variants.find((candidate) => candidate.styleId === styles[row].id && candidate.date === dates[column].date);
      if (!variant) continue;
      const label = Buffer.from(`<svg width="${tileWidth}" height="${labelHeight}"><rect width="100%" height="100%" fill="#f5f2ea"/><text x="20" y="35" font-family="-apple-system,Helvetica,sans-serif" font-size="22" font-weight="600" fill="#111">${row + 1}. ${escapeHtml(styles[row].label)}</text></svg>`);
      const top = headerHeight + row * rowHeight;
      const tile = await sharp(path.join(variant.directory, 'display-preview.png'))
        .resize(tileWidth, imageHeight, { fit: 'cover', position: 'centre' })
        .png()
        .toBuffer();
      composites.push({ input: label, left: column * tileWidth, top });
      composites.push({ input: tile, left: column * tileWidth, top: top + labelHeight });
    }
  }

  await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(path.join(root, file));
}

function studyHtml(dates: Array<{ date: string; label: string }>, variants: StudyVariant[], styles: StyleDirection[]): string {
  const rows = styles.map((style, row) => {
    const cells = dates.map(({ date }) => {
      const variant = variants.find((candidate) => candidate.styleId === style.id && candidate.date === date);
      if (!variant) return '<td>Missing</td>';
      const relative = path.basename(variant.directory);
      return `<td><img src="${escapeHtml(path.join(relative, 'display-preview.png'))}" alt="${escapeHtml(style.label)} e-ink preview"><p>QA: ${variant.qa.pass ? 'pass' : 'review'} · attempts: ${variant.attempts}</p></td>`;
    }).join('');
    return `<tr><th>${row + 1}. ${escapeHtml(style.label)}</th>${cells}</tr>`;
  }).join('\n');
  const headers = dates.map(({ date, label }) => `<th>${escapeHtml(label)}<br>${date}</th>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Eink aesthetic study</title><style>body{font:15px -apple-system,sans-serif;margin:24px;background:#eee;color:#111}h1{margin:0 0 8px}p{color:#555}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid #ccc;padding:10px;vertical-align:top}th{background:#fafafa}img{display:block;width:100%;margin-bottom:8px}td p{margin:0}tr>th:first-child{width:180px}</style><h1>Eink aesthetic study</h1><p>Each cell is the exact six-color display preview. Same style is tested across both dates.</p><table><thead><tr><th>Direction</th>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
}

export async function rebuildStyleStudy(root: string): Promise<void> {
  const study = JSON.parse(await readFile(path.join(root, 'study.json'), 'utf8')) as {
    dates: Array<{ date: string; label: string }>;
    styles: StyleDirection[];
    variants: StudyVariant[];
  };
  await contactSheet(root, 'eink-contact-sheet.png', study.dates, study.variants, study.styles);
}

export async function runStyleStudy(config: AppConfig, round = 1): Promise<{ root: string; variants: StudyVariant[] }> {
  if (round !== 1 && round !== 2 && round !== 3) throw new Error('Style-study round must be 1, 2, or 3');
  const styles = round === 3 ? ROUND_THREE_STYLES : round === 2 ? ROUND_TWO_STYLES : ROUND_ONE_STYLES;
  const briefDirection = round === 3 ? ROUND_THREE_BRIEF_DIRECTION : round === 2 ? ROUND_TWO_BRIEF_DIRECTION : undefined;
  const qaDirection = round === 3 ? ROUND_THREE_QA : round === 2 ? ROUND_TWO_QA : undefined;
  const today = todayBounds(config.timezone).date;
  const monday = nextMonday(today);
  const dates = [
    { date: today, label: 'Today' },
    { date: monday, label: 'Monday' },
  ];
  const root = path.join(paths.support, 'style-studies', `round-${round}-${today}-vs-${monday}-${Date.now()}`);
  await ensureDirectory(root);
  const history = await recentBriefs(config.art.conceptMemoryDays);
  const contexts = new Map<string, CreativeBrief>();

  for (const candidate of dates) {
    const editionNow = dateAtNoon(candidate.date, config.timezone);
    const [events, weather] = await Promise.all([
      fetchTodayEvents(config, editionNow),
      fetchWeather(config, candidate.date),
    ]);
    contexts.set(candidate.date, await createBrief(config, candidate.date, events, weather, history, true, briefDirection));
  }
  await atomicWrite(path.join(root, 'contexts.json'), `${JSON.stringify(Object.fromEntries(contexts), null, 2)}\n`);

  const variants: StudyVariant[] = [];
  let index = 0;
  for (const style of styles) {
    for (const candidate of dates) {
      index += 1;
      const brief = contexts.get(candidate.date);
      if (!brief) throw new Error(`Missing creative brief for ${candidate.date}`);
      let correction: string | undefined;
      let finalQa: QaResult | undefined;
      let finalDirectory = '';
      let attempts = 0;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        attempts = attempt;
        const variantDirectory = path.join(root, `${String(index).padStart(2, '0')}-${candidate.label.toLowerCase()}-${style.id}-${randomUUID().slice(0, 6)}-a${attempt}`);
        try {
          const artwork = await generateArtwork(config, brief, correction, style.direction);
          const rendered = await renderArtwork(artwork.bytes);
          const qa = await inspectArtwork(config, rendered.original, rendered.preview, qaDirection, brief);
          if (qa.pass || attempt === 3) {
            await ensureDirectory(variantDirectory);
            await Promise.all([
              atomicWrite(path.join(variantDirectory, 'display-preview.png'), rendered.preview),
              atomicWrite(path.join(variantDirectory, 'display.bmp'), rendered.bmp),
              atomicWrite(path.join(variantDirectory, 'qa.json'), `${JSON.stringify(qa, null, 2)}\n`),
            ]);
          }
          finalQa = qa;
          finalDirectory = variantDirectory;
          if (qa.pass) break;
          correction = qa.correction || qa.reasons.join('; ');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stdout.write(`[${index}/8] ${candidate.label} · ${style.label} · attempt ${attempt} failed: ${message}\n`);
          if (attempt === 3) throw error;
        }
      }
      if (!finalQa) throw new Error(`No image generated for ${candidate.date}/${style.id}`);
      variants.push({
        index,
        date: candidate.date,
        dayLabel: candidate.label,
        styleId: style.id,
        styleLabel: style.label,
        directory: finalDirectory,
        brief,
        qa: finalQa,
        attempts,
      });
      await atomicWrite(path.join(root, 'study-progress.json'), `${JSON.stringify({ createdAt: new Date().toISOString(), round, dates, styles, variants }, null, 2)}\n`);
      process.stdout.write(`[${index}/8] ${candidate.label} · ${style.label} · ${finalQa.pass ? 'QA pass' : 'needs review'}\n`);
    }
  }

  await Promise.all([
    contactSheet(root, 'eink-contact-sheet.png', dates, variants, styles),
    atomicWrite(path.join(root, 'study.json'), `${JSON.stringify({ createdAt: new Date().toISOString(), round, dates, styles, variants }, null, 2)}\n`),
    atomicWrite(path.join(root, 'index.html'), studyHtml(dates, variants, styles)),
  ]);
  return { root, variants };
}
