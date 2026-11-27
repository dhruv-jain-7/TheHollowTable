import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBooleanReadinessCache,
  createNonOverlappingTask,
  createTokenBucket,
  runRoomBatchSafely,
  shiftRestoredRoomTimers,
} from './runtimeSafety.js';

test('restoration shifts all absolute phase deadlines by the server downtime', () => {
  const room = {
    phaseEndsAt: 20_000,
    phaseMinUntil: 12_000,
    nightStepMinUntil: null,
    transition: { startedAt: 8_000, durationMs: 5_000 },
  };
  const shiftedBy = shiftRestoredRoomTimers(room, 10_000, 16_000);
  assert.equal(shiftedBy, 6_000);
  assert.equal(room.phaseEndsAt, 26_000);
  assert.equal(room.phaseMinUntil, 18_000);
  assert.equal(room.nightStepMinUntil, null);
  assert.equal(room.transition.startedAt, 14_000);
  assert.equal(room.transition.durationMs, 5_000);
});

test('restoration does not shift deadlines for missing or invalid timestamps', () => {
  const room = { phaseEndsAt: 20_000, transition: { startedAt: 8_000 } };
  assert.equal(shiftRestoredRoomTimers(room, null, 30_000), 0);
  assert.equal(shiftRestoredRoomTimers(room, 40_000, 30_000), 0);
  assert.equal(room.phaseEndsAt, 20_000);
  assert.equal(room.transition.startedAt, 8_000);
});

test('per-socket token bucket allows its burst then refills at the configured rate', () => {
  let now = 0;
  const consume = createTokenBucket({ capacity: 3, refillPerSecond: 2, now: () => now });
  assert.equal(consume(), true);
  assert.equal(consume(), true);
  assert.equal(consume(), true);
  assert.equal(consume(), false);
  now = 500;
  assert.equal(consume(), true);
  assert.equal(consume(), false);
  now = 1_000;
  assert.equal(consume(), true);
});

test('one room failure does not stop processing subsequent rooms', async () => {
  const processed = [];
  const quarantined = [];
  const rooms = [{ code: 'AAAA' }, { code: 'BBBB' }, { code: 'CCCC' }];
  await runRoomBatchSafely(
    rooms,
    async (room) => {
      processed.push(room.code);
      if (room.code === 'BBBB') throw new Error('synthetic room failure');
    },
    async (room, error) => quarantined.push({ code: room.code, message: error.message }),
  );
  assert.deepEqual(processed, ['AAAA', 'BBBB', 'CCCC']);
  assert.deepEqual(quarantined, [{ code: 'BBBB', message: 'synthetic room failure' }]);
});

test('a non-overlapping task skips concurrent invocations and can run again later', async () => {
  let release;
  let calls = 0;
  const task = createNonOverlappingTask(async () => {
    calls += 1;
    if (calls === 1) await new Promise((resolve) => { release = resolve; });
  });
  const first = task();
  assert.equal(await task(), false);
  assert.equal(calls, 1);
  release();
  assert.equal(await first, true);
  assert.equal(await task(), true);
  assert.equal(calls, 2);
});

test('narrator readiness cache checks files only when refreshed', () => {
  let checks = 0;
  let healthy = true;
  const cache = createBooleanReadinessCache(() => {
    checks += 1;
    return healthy;
  });
  assert.equal(cache.read(), false);
  assert.equal(checks, 0);
  assert.equal(cache.refresh(), true);
  assert.equal(cache.read(), true);
  assert.equal(checks, 1);
  healthy = false;
  assert.equal(cache.read(), true);
  assert.equal(cache.refresh(), false);
  assert.equal(checks, 2);
});
