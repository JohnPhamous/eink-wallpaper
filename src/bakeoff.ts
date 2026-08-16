import { randomInt } from 'node:crypto';
import path from 'node:path';
import { generateArtwork } from './ai.js';
import { atomicWrite, ensureDirectory } from './fs.js';
import { renderArtwork } from './render.js';
import { paths } from './paths.js';
import { todayBounds } from './time.js';
import type { AppConfig, CreativeBrief } from './types.js';

const SCENARIOS = [
  ['rainy morning', 'a reflective Seattle street after rain', 'bounding over luminous puddles', 'fresh and quietly determined'],
  ['gym day', 'a sculptural pastel training landscape', 'playfully bracing to move an enormous soft geometric weight', 'energetic but serene'],
  ['major launch', 'a floating garden observatory at first light', 'releasing one bright seed-pod into a vast open sky', 'momentous and optimistic'],
  ['travel day', 'a dreamlike coastal transit causeway', 'trotting toward a distant glowing gateway with a tiny travel satchel-shaped prop nearby', 'anticipatory and spacious'],
  ['empty sunny day', 'a sunlit futuristic Seattle hillside garden', 'chasing a ribbon of warm light through tall grass', 'unhurried and joyful'],
  ['severe storm', 'a protected glassy shelter above a wind-swept landscape', 'standing safely and alert as the storm curls around the shelter', 'dramatic, secure, never anxious'],
  ['personal dinner', 'an intimate outdoor table-like still life garden with no place settings for people', 'carefully carrying one glowing fruit toward the centerpiece', 'warm and celebratory'],
  ['dense meetings', 'an abstract landscape of flowing pathways and soft portals', 'fluidly weaving through the paths without collision', 'busy yet graceful'],
  ['foggy morning', 'a dimensional sea of peach and blue fog around rounded architecture', 'emerging from the mist with curious momentum', 'mysterious and gentle'],
  ['creative review', 'a landscape of floating color planes and tactile materials', 'nudging the final cobalt shape into a harmonious composition', 'focused and lightly funny'],
  ['out of office', 'a broad wildflower coast beyond an open futuristic threshold', 'sprinting away from a neat stack of inert geometric blocks', 'liberated and breezy'],
  ['snow possibility', 'a quiet pastel neighborhood transformed by broad crystalline forms', 'testing the air with one paw as the first flakes descend', 'wondrous and calm'],
] as const;

function briefFor(index: number): CreativeBrief {
  const [title, setting, action, mood] = SCENARIOS[index];
  return {
    title,
    anchorRationale: 'Synthetic model-comparison scenario; contains no personal facts.',
    metaphor: `${title} expressed as an original environmental adventure`,
    setting,
    bichonAction: action,
    mood,
    lighting: index % 3 === 0 ? 'soft early-morning side light' : index % 3 === 1 ? 'pastel overcast glow' : 'warm late-afternoon radiance',
    palette: index % 2 === 0 ? ['cobalt blue', 'soft red', 'warm yellow', 'mist white'] : ['pastel blue', 'leaf green', 'coral red', 'cream'],
    weatherMotif: title,
    composition: 'single full-bleed wide shot with one strong central action and generous breathing room',
    scenePrompt: `Create one original cinematic landscape illustration: ${setting}. The only living character is one white fluffy bichon with a subtle cobalt-blue collar, ${action}. ${mood}. Reduced line density, fluid character mobility, soft pastel-futuristic gradients, dimensional 3D-blended environmental textures, strong silhouette, broad e-ink-friendly color regions. Sophisticated animation production design. No existing franchise imagery. No text or logos. No other character, person, animal, creature, robot, silhouette, or face.`,
    avoid: ['text', 'logos', 'other characters', 'franchise imagery', 'clutter', 'cropped dog'],
    conceptKey: `synthetic-${index + 1}-${title.replace(/\s+/g, '-')}`,
  };
}

export async function runBichonBakeoff(
  config: AppConfig,
  models = ['google/gemini-3.1-flash-image', 'xai/grok-imagine-image-2.0'],
): Promise<string> {
  if (models.length !== 2) throw new Error('Bakeoff requires exactly two model slugs');
  const date = todayBounds(config.timezone).date;
  const root = path.join(paths.support, 'bakeoffs', `${date}-${Date.now()}`);
  await ensureDirectory(root);
  const answers: Array<{ scene: number; A: string; B: string }> = [];
  const sections: string[] = [];
  for (let index = 0; index < SCENARIOS.length; index += 1) {
    const ordered = randomInt(2) === 0 ? models : [models[1], models[0]];
    const outputs: string[] = [];
    for (const [position, model] of ordered.entries()) {
      const label = position === 0 ? 'A' : 'B';
      const candidateConfig: AppConfig = {
        ...config,
        models: { ...config.models, image: model },
      };
      const sceneDirectory = path.join(root, `${String(index + 1).padStart(2, '0')}-${label}`);
      const generated = await generateArtwork(candidateConfig, briefFor(index));
      const rendered = await renderArtwork(generated.bytes, sceneDirectory);
      outputs.push(path.relative(root, path.join(sceneDirectory, rendered.previewFile)));
    }
    answers.push({ scene: index + 1, A: ordered[0], B: ordered[1] });
    sections.push(`<section><h2>Scene ${index + 1}</h2><div><figure><img src="${outputs[0]}"><figcaption>A</figcaption></figure><figure><img src="${outputs[1]}"><figcaption>B</figcaption></figure></div></section>`);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>Eink Wallpaper blind bakeoff</title><style>body{font:16px system-ui;margin:32px;background:#eee;color:#111}section{margin:0 0 48px}section div{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}img{display:block;width:100%;image-rendering:auto;background:white}figcaption{text-align:center;font-size:24px;font-weight:700;margin-top:8px}</style><h1>Blind bichon bakeoff</h1><p>Score bichon clarity, single-character compliance, crop safety, composition, stylistic consistency, and six-color survival.</p>${sections.join('')}`;
  await Promise.all([
    atomicWrite(path.join(root, 'index.html'), html),
    atomicWrite(path.join(root, 'answers.json'), `${JSON.stringify(answers, null, 2)}\n`),
  ]);
  return path.join(root, 'index.html');
}
