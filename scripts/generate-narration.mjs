import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const sourcePath = path.join(scriptDir, 'narration-manifest.json');
const audioDir = path.join(projectRoot, 'client', 'public', 'audio');
const statePath = path.join(audioDir, 'pack-manifest.json');
const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
const manifest = JSON.parse(await readFile(sourcePath, 'utf8'));
const voiceId = manifest.voiceId;
const modelId = process.env.HOLLOW_ELEVENLABS_MODEL?.trim() || manifest.modelId;
const outputFormat = manifest.outputFormat || 'mp3_44100_128';
const overwrite = process.argv.includes('--overwrite');
const budget = Number(process.env.HOLLOW_AUDIO_CHAR_BUDGET || 4000);
const totalCharacters = manifest.clips.reduce((sum, clip) => sum + clip.text.length, 0);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!apiKey) {
  console.error('\nMissing ELEVENLABS_API_KEY. Set it in this PowerShell window, then run npm run audio:generate.');
  process.exit(1);
}
if (!voiceId || !Array.isArray(manifest.clips) || manifest.clips.length === 0
    || new Set(manifest.clips.map((clip) => clip.id)).size !== manifest.clips.length
    || manifest.clips.some((clip) => !/^[a-z0-9_]+$/.test(clip.id || '') || typeof clip.text !== 'string' || !clip.text.trim())) {
  console.error('Narration manifest is invalid: clip IDs must be unique safe filenames and every clip needs text.');
  process.exit(1);
}
if (!Number.isFinite(budget) || budget < 1 || totalCharacters > budget) {
  console.error(`Safety budget exceeded: ${totalCharacters} input characters, budget ${budget}. Nothing was generated.`);
  process.exit(1);
}

await mkdir(audioDir, { recursive: true });
let packState = { name: manifest.name, version: manifest.version, voiceId, modelId, outputFormat, createdAt: null, clips: {} };
try {
  packState = JSON.parse(await readFile(statePath, 'utf8'));
} catch { /* First generation. */ }
if (packState.voiceId && (packState.voiceId !== voiceId || packState.modelId !== modelId)) {
  const hasExistingAudio = Object.values(packState.clips || {}).some((entry) => entry?.file && entry?.bytes > 2048);
  if (hasExistingAudio && !overwrite) {
    console.error('Existing audio files belong to a different voice or model. Use --overwrite only when you intend to regenerate them.');
    process.exit(1);
  }
  packState = { clips: {} };
}
packState.name = manifest.name;
packState.version = manifest.version;
packState.voiceId = voiceId;
packState.modelId = modelId;
packState.outputFormat = outputFormat;
packState.complete = false;
delete packState.completedAt;
packState.clips ||= {};
await writeFile(statePath, `${JSON.stringify(packState, null, 2)}\n`, 'utf8');

console.log('\nTHE HOLLOW TABLE — NARRATION GENERATOR');
console.log(`Voice ID: ${voiceId}`);
console.log(`Model: ${modelId}`);
console.log(`Clips: ${manifest.clips.length}`);
console.log(`Estimated input: ${totalCharacters.toLocaleString()} characters (safety budget: ${budget.toLocaleString()})`);
console.log(`Output: ${audioDir}`);
console.log(overwrite ? 'Mode: overwrite existing clips' : 'Mode: keep existing clips; generate missing files only');

let generated = 0;
let skipped = 0;
let spentCharacters = 0;

for (let index = 0; index < manifest.clips.length; index += 1) {
  const clip = manifest.clips[index];
  const fileName = `${clip.id}.mp3`;
  const finalPath = path.join(audioDir, fileName);
  const temporaryPath = `${finalPath}.partial`;

  if (!overwrite) {
    try {
      const existing = await stat(finalPath);
      if (existing.size > 2048) {
        const bytes = await readFile(finalPath);
        const existingLooksLikeMp3 = bytes.subarray(0, 3).toString('ascii') === 'ID3'
          || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
        if (!existingLooksLikeMp3) throw new Error('Existing file is not a valid MP3');
        packState.clips[clip.id] = {
          file: fileName,
          characters: clip.text.length,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        await writeFile(statePath, `${JSON.stringify(packState, null, 2)}\n`, 'utf8');
        console.log(`[${index + 1}/${manifest.clips.length}] SKIP  ${fileName} (already exists)`);
        skipped += 1;
        continue;
      }
    } catch { /* File is missing or invalid; regenerate it safely. */ }
  }

  console.log(`[${index + 1}/${manifest.clips.length}] CREATE ${fileName} (${clip.text.length} characters)`);
  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: clip.text,
        model_id: modelId,
        language_code: 'en',
        seed: 713,
        apply_text_normalization: 'auto',
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (error) {
    console.error(`Network error while generating ${fileName}: ${error.message}`);
    console.error('Stopped safely. Existing clips were left untouched. Rerun the same command to continue.');
    process.exit(1);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => 'No error details returned.');
    console.error(`ElevenLabs returned HTTP ${response.status} for ${fileName}.`);
    console.error(detail.slice(0, 1600));
    if (response.status === 401 || response.status === 403) {
      console.error('Check the API key permissions and confirm this voice is available to the API key.');
    } else if (response.status === 429) {
      console.error('The account rate limit or credit allowance may have been reached. Wait or check your ElevenLabs usage page.');
    }
    console.error('Stopped safely. Successfully generated files remain saved. Rerun to continue after fixing the issue.');
    process.exit(1);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const looksLikeMp3 = bytes.length > 2048 && (
    bytes.subarray(0, 3).toString('ascii') === 'ID3'
    || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
  if (!looksLikeMp3) {
    console.error(`The response for ${fileName} was not a valid MP3 (${bytes.length} bytes).`);
    process.exit(1);
  }

  await writeFile(temporaryPath, bytes, { flag: 'w' });
  await rename(temporaryPath, finalPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  packState.clips[clip.id] = {
    file: fileName,
    characters: clip.text.length,
    bytes: bytes.length,
    sha256: digest,
  };
  packState.createdAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(packState, null, 2)}\n`, 'utf8');
  generated += 1;
  spentCharacters += clip.text.length;
  console.log(`        SAVED ${(bytes.length / 1024).toFixed(1)} KB`);
  await delay(900);
}

const missing = [];
for (const clip of manifest.clips) {
  const fileName = `${clip.id}.mp3`;
  const filePath = path.join(audioDir, fileName);
  const metadata = packState.clips?.[clip.id];
  try {
    const fileStat = await stat(filePath);
    if (metadata?.file !== fileName || !metadata?.sha256 || !metadata?.bytes || fileStat.size <= 2048 || fileStat.size !== metadata.bytes) missing.push(clip.id);
  } catch {
    missing.push(clip.id);
  }
}

console.log('\nGENERATION SUMMARY');
console.log(`Generated now: ${generated}`);
console.log(`Skipped existing: ${skipped}`);
console.log(`Characters submitted in this run: ${spentCharacters}`);
console.log(`Required clips still missing from generation manifest: ${missing.length}`);
if (missing.length === 0) {
  packState.complete = true;
  packState.completedAt = new Date().toISOString();
  await writeFile(statePath, `${JSON.stringify(packState, null, 2)}\n`, 'utf8');
  console.log('VOICE PACK COMPLETE. The game can now use the In-Person narrator.');
} else {
  packState.complete = false;
  await writeFile(statePath, `${JSON.stringify(packState, null, 2)}\n`, 'utf8');
  console.log('VOICE PACK INCOMPLETE. Rerun npm run audio:generate to create remaining clips.');
  process.exitCode = 1;
}
