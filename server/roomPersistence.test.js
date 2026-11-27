import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_ROOM_TTL_MS,
  FINISHED_ROOM_TTL_MS,
  ROOM_SCHEMA_VERSION,
  migrateRoomState,
  roomExpiresAt,
  roomHasExpired,
} from './roomPersistence.js';

test('legacy room snapshots migrate to the current schema version', () => {
  const room = { code: 'ABCD', status: 'playing' };
  assert.equal(migrateRoomState(room), room);
  assert.equal(room.schemaVersion, ROOM_SCHEMA_VERSION);
  assert.equal(room.narratorPausedAt, null);
});

test('future or invalid room schema versions are rejected safely', () => {
  assert.equal(migrateRoomState({ schemaVersion: ROOM_SCHEMA_VERSION + 1 }), null);
  assert.equal(migrateRoomState(null), null);
  assert.equal(migrateRoomState({ schemaVersion: 1.5 }), null);
});

test('finished rooms expire two hours after completion', () => {
  const now = 100_000;
  const room = { status: 'finished', finishedAt: now };
  assert.equal(roomExpiresAt(room, now).getTime(), now + FINISHED_ROOM_TTL_MS);
  assert.equal(roomHasExpired(room, now + FINISHED_ROOM_TTL_MS), true);
  assert.equal(roomHasExpired(room, now + FINISHED_ROOM_TTL_MS - 1), false);
});

test('active rooms retain the existing 24-hour inactivity period', () => {
  const now = 100_000;
  const room = { status: 'playing', lastActivityAt: now };
  assert.equal(roomExpiresAt(room, now).getTime(), now + ACTIVE_ROOM_TTL_MS);
  assert.equal(roomHasExpired(room, now + ACTIVE_ROOM_TTL_MS), true);
});
