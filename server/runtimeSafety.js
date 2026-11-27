/** Small, dependency-free runtime guards shared by the game server and tests. */

export function shiftRestoredRoomTimers(room, savedAt, restoredAt = Date.now()) {
  if (!room || typeof room !== 'object') return 0;
  if (savedAt === null || savedAt === undefined || savedAt === '') return 0;
  const savedAtMs = savedAt instanceof Date ? savedAt.getTime() : new Date(savedAt).getTime();
  if (!Number.isFinite(savedAtMs) || !Number.isFinite(restoredAt)) return 0;
  const downtimeMs = Math.max(0, restoredAt - savedAtMs);
  if (downtimeMs === 0) return 0;

  for (const key of ['phaseEndsAt', 'phaseMinUntil', 'nightStepMinUntil']) {
    if (Number.isFinite(room[key])) room[key] += downtimeMs;
  }
  if (room.transition && Number.isFinite(room.transition.startedAt)) {
    room.transition.startedAt += downtimeMs;
  }
  return downtimeMs;
}

export function createTokenBucket({ capacity = 30, refillPerSecond = 15, now = Date.now } = {}) {
  const safeCapacity = Math.max(1, Number(capacity) || 1);
  const safeRefill = Math.max(0.1, Number(refillPerSecond) || 0.1);
  let tokens = safeCapacity;
  let lastRefillAt = now();

  return function consumeToken(at = now()) {
    const elapsedSeconds = Math.max(0, at - lastRefillAt) / 1000;
    tokens = Math.min(safeCapacity, tokens + elapsedSeconds * safeRefill);
    lastRefillAt = Math.max(lastRefillAt, at);
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export async function runRoomBatchSafely(roomList, processRoom, onRoomError) {
  for (const room of roomList) {
    try {
      await processRoom(room);
    } catch (error) {
      try {
        await onRoomError(room, error);
      } catch (handlerError) {
        // A failure while reporting one room must not block later rooms either.
        console.error(`Could not quarantine room ${room?.code || 'unknown'}:`, handlerError);
      }
    }
  }
}

export function createNonOverlappingTask(task) {
  let running = false;
  return async (...args) => {
    if (running) return false;
    running = true;
    try {
      await task(...args);
      return true;
    } finally {
      running = false;
    }
  };
}

export function createBooleanReadinessCache(check) {
  let ready = false;
  return {
    read: () => ready,
    refresh: () => {
      try {
        ready = Boolean(check());
      } catch {
        ready = false;
      }
      return ready;
    },
  };
}

/** Pause an In-Person room while its assigned narrator cannot speak, then
 * extend every absolute game deadline by the exact pause duration on recovery. */
export function reconcileNarratorClockPause(room, narratorReady, now = Date.now()) {
  if (!room || typeof room !== 'object' || !Number.isFinite(now)) {
    return { changed: false, paused: false, resumedMs: 0 };
  }
  if (room.status !== 'playing' || room.gameMode !== 'in_person') {
    if (Number.isFinite(room.narratorPausedAt)) {
      // Pauses are only meaningful while an In-Person game is actively running.
      // Lobby/finished room deadlines must not be extended by a stale marker.
      room.narratorPausedAt = null;
      return { changed: true, paused: false, resumedMs: 0 };
    }
    return { changed: false, paused: false, resumedMs: 0 };
  }
  if (!narratorReady) {
    if (!Number.isFinite(room.narratorPausedAt)) {
      room.narratorPausedAt = now;
      return { changed: true, paused: true, resumedMs: 0 };
    }
    return { changed: false, paused: true, resumedMs: 0 };
  }
  if (Number.isFinite(room.narratorPausedAt)) {
    const resumedMs = shiftRestoredRoomTimers(room, room.narratorPausedAt, now);
    room.narratorPausedAt = null;
    return { changed: true, paused: false, resumedMs };
  }
  return { changed: false, paused: false, resumedMs: 0 };
}
