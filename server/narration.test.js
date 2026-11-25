import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNarrationCue } from '../client/src/audio/narration.js';
import { IN_PERSON_NIGHT_STEP_MINIMUM_SECONDS } from './inPersonRules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'scripts/narration-manifest.json'), 'utf8'));
const clipIds = new Set(manifest.clips.map((clip) => clip.id));

test('every narration mapping points to a generated clip', () => {
  const nightSteps = ['role_reveal', 'town_sleep', 'mafia', 'mafia_clash', 'mafia_sleep', 'angel', 'angel_sleep', 'sheriff', 'sheriff_sleep', 'town_wake'];
  const snapshots = nightSteps.map((nightStep) => ({
    gameMode: 'in_person', status: 'playing', phase: 'night', nightStep,
    nightCue: { id: `cue-${nightStep}`, cueId: `cue-${nightStep}` },
  }));
  snapshots.push(
    { gameMode: 'in_person', status: 'playing', phase: 'discussion', round: 1 },
    { gameMode: 'in_person', status: 'playing', phase: 'voting', round: 1 },
    { gameMode: 'in_person', status: 'playing', phase: 'tieVoting', round: 1, tieCandidates: [{ id: 'p1' }, { id: 'p2' }] },
    ...[
      ['murder', 'murder_report'], ['quiet', 'quiet_report'], ['elimination', 'elimination_report'],
      ['no-elimination', 'no_elimination'], ['departure', 'departure_report'], ['tie', 'tie_announcement'],
    ].map(([kind]) => ({ gameMode: 'in_person', status: 'playing', phase: 'transition', announcement: { id: `a-${kind}`, kind } })),
    { gameMode: 'in_person', status: 'finished', winner: 'mafia', announcement: { id: 'win-mafia' } },
    { gameMode: 'in_person', status: 'finished', winner: 'town', announcement: { id: 'win-town' } },
  );
  for (const snapshot of snapshots) {
    const cue = getNarrationCue(snapshot);
    assert.ok(cue, `expected a cue for ${snapshot.nightStep || snapshot.phase || snapshot.announcement?.kind}`);
    assert.ok(clipIds.has(cue.clip), `missing manifest clip ${cue.clip}`);
  }
});

test('Online snapshots and lobby snapshots never trigger narration', () => {
  assert.equal(getNarrationCue({ gameMode: 'online', status: 'playing', phase: 'discussion', round: 1 }), null);
  assert.equal(getNarrationCue({ gameMode: 'in_person', status: 'lobby', phase: 'lobby' }), null);
});

test('Sheriff private results are never used as public narration', () => {
  const snapshot = {
    gameMode: 'in_person', status: 'playing', phase: 'night', nightStep: 'sheriff',
    nightCue: { cueId: 'sheriff-cue' },
    me: { role: 'sheriff', privateResults: [{ id: 'private', text: 'Dhruv is Mafia' }] },
  };
  const cue = getNarrationCue(snapshot);
  assert.equal(cue.clip, 'sheriff_awaken');
  assert.equal(JSON.stringify(cue).includes('Dhruv'), false);
  assert.equal(JSON.stringify(cue).includes('private'), false);
});


test('night narration receives a minimum playback window before early role advancement', () => {
  assert.deepEqual(IN_PERSON_NIGHT_STEP_MINIMUM_SECONDS, {
    role_reveal: 12, mafia: 11, mafia_clash: 11, angel: 11, sheriff: 10,
  });
});

test('narration pack stays within the local generation safety budget', () => {
  assert.equal(new Set(manifest.clips.map((clip) => clip.id)).size, manifest.clips.length);
  assert.ok(manifest.clips.every((clip) => clip.text.length > 0 && clip.text.length < 1000));
  assert.ok(manifest.clips.reduce((sum, clip) => sum + clip.text.length, 0) < 4000);
  assert.ok(manifest.clips.every((clip) => typeof clip.text === 'string' && /^\[.+?\] /.test(clip.text)));
});
