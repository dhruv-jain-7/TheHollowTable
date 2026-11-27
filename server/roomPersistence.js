/** Versioning and retention policy for the persisted room JSON document. */
export const ROOM_SCHEMA_VERSION = 2;
export const ACTIVE_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const FINISHED_ROOM_TTL_MS = 2 * 60 * 60 * 1000;

export function migrateRoomState(room) {
  if (!room || typeof room !== 'object' || Array.isArray(room)) return null;
  const version = Number(room.schemaVersion ?? 1);
  if (!Number.isInteger(version) || version < 1 || version > ROOM_SCHEMA_VERSION) return null;

  // Version 2 adds explicit narrator-pause state. Older snapshots safely start
  // with no pause marker; startup restoration will establish one if needed.
  if (version < 2) room.narratorPausedAt = null;
  room.narratorPausedAt ??= null;
  room.schemaVersion = ROOM_SCHEMA_VERSION;
  return room;
}

export function roomExpiresAt(room, now = Date.now()) {
  if (room?.status === 'finished') {
    const finishedAt = Number(room.finishedAt);
    const base = Number.isFinite(finishedAt) && finishedAt > 0 ? finishedAt : now;
    return new Date(base + FINISHED_ROOM_TTL_MS);
  }
  return new Date(now + ACTIVE_ROOM_TTL_MS);
}

export function roomHasExpired(room, now = Date.now()) {
  if (!room || typeof room !== 'object') return true;
  if (room.status === 'finished') {
    const finishedAt = Number(room.finishedAt || room.lastActivityAt || room.createdAt || now);
    return now - finishedAt >= FINISHED_ROOM_TTL_MS;
  }
  const lastActivityAt = Number(room.lastActivityAt || room.createdAt || now);
  return now - lastActivityAt >= ACTIVE_ROOM_TTL_MS;
}
