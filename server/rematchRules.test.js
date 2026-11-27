import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRoomRematch } from './rematchRules.js';

function fixture(mode = 'online') {
  const players = Array.from({ length: 6 }, (_, i) => ({
    id: `p${i + 1}`, name: `Player ${i + 1}`, connected: true,
    tokenHash: `hash-${i + 1}`, role: i === 0 ? 'mafia' : 'citizen',
    alive: i !== 1, disconnectAt: null, privateResults: [{ id: 'private' }],
    undertakerUsed: i === 3, eliminationKind: 'murder', eliminatedAt: 10,
  }));
  return {
    status: 'finished', gameMode: mode, players, hostId: 'p1', narratorId: mode === 'in_person' ? 'p2' : null,
    narratorReadyId: 'p2', narratorPausedAt: 10, round: 4, phase: 'finished',
    phaseEndsAt: 20, phaseMinUntil: 10, nightStep: 'sheriff', nightStepMinUntil: 11,
    nightCue: { id: 'cue' }, identityReady: { p1: true }, actions: { dayVotes: { p1: 'p2' } },
    tieCandidates: ['p1'], transition: { id: 'transition' }, voteReveal: { rows: [] },
    mafiaConflictExtensionUsed: true, inPersonMafiaTargetId: 'p2', angelLastProtectedTargetId: 'p3',
    winner: 'mafia', finishedAt: 30, lastDeathAnnouncement: { kind: 'murder' },
    chat: [{ text: 'old chat' }], clockQuarantined: false, announcement: { kind: 'victory' },
  };
}
const helpers = {
  now: 1000,
  freshActions: () => ({ mafiaVotes: {}, dayVotes: {}, dayReady: {}, angelTarget: null, sheriffTarget: null, undertakerDecision: null }),
  makeAnnouncement: (kind, title, text, accent) => ({ kind, title, text, accent }),
};

test('rematch keeps only connected authenticated players and resets game state', () => {
  const room = fixture();
  room.players[5].connected = false;
  room.players[5].disconnectAt = 500;
  const result = prepareRoomRematch(room, ['p1', 'p2', 'p3', 'p4', 'p5'], helpers);
  assert.equal(result.ok, true);
  assert.equal(room.status, 'lobby');
  assert.equal(room.phase, 'lobby');
  assert.equal(room.round, 0);
  assert.equal(room.players.length, 5);
  for (const player of room.players) {
    assert.equal(player.role, null);
    assert.equal(player.alive, true);
    assert.equal(player.privateResults.length, 0);
    assert.equal(player.undertakerUsed, false);
    assert.equal(player.eliminationKind, null);
  }
  assert.deepEqual(room.actions, helpers.freshActions());
  assert.deepEqual(room.chat, []);
  assert.equal(room.winner, null);
  assert.equal(room.finishedAt, null);
  assert.equal(room.announcement.kind, 'welcome');
});

test('rematch does not start with fewer than five authenticated connected players', () => {
  const room = fixture();
  const result = prepareRoomRematch(room, ['p1', 'p2', 'p3', 'p4'], helpers);
  assert.deepEqual(result, { ok: false, reason: 'not-enough-players', required: 5, available: 4 });
  assert.equal(room.status, 'finished');
  assert.equal(room.winner, 'mafia');
});

test('only a finished game can be rematched', () => {
  const room = fixture();
  room.status = 'playing';
  const result = prepareRoomRematch(room, room.players.map((player) => player.id), helpers);
  assert.deepEqual(result, { ok: false, reason: 'not-finished' });
});

test('In-Person rematch keeps the narrator seat but requires fresh audio enablement', () => {
  const room = fixture('in_person');
  const result = prepareRoomRematch(room, room.players.map((player) => player.id), helpers);
  assert.equal(result.ok, true);
  assert.equal(room.narratorId, 'p2');
  assert.equal(room.narratorReadyId, null);
  assert.equal(room.narratorPausedAt, null);
});

test('rematch elects an available host and narrator if the prior seats are gone', () => {
  const room = fixture('in_person');
  room.players = room.players.filter((player) => player.id !== 'p1' && player.id !== 'p2');
  room.hostId = 'p1';
  room.narratorId = 'p2';
  const result = prepareRoomRematch(room, room.players.map((player) => player.id), helpers);
  assert.equal(result.ok, true);
  assert.equal(room.hostId, 'p3');
  assert.equal(room.narratorId, 'p3');
});
