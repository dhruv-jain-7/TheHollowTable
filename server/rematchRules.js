/**
 * Reset a completed room for a fresh game while preserving only connected,
 * authenticated seats. Existing reconnect tokens are kept for those players.
 */
export function prepareRoomRematch(room, connectedPlayerIds, { now = Date.now(), freshActions, makeAnnouncement } = {}) {
  if (!room || room.status !== 'finished') return { ok: false, reason: 'not-finished' };
  if (typeof freshActions !== 'function' || typeof makeAnnouncement !== 'function') {
    throw new TypeError('Rematch reset helpers are required.');
  }

  const connected = new Set(Array.isArray(connectedPlayerIds) ? connectedPlayerIds : []);
  const retained = room.players.filter((player) => player.connected && player.tokenHash && connected.has(player.id));
  if (retained.length < 5) return { ok: false, reason: 'not-enough-players', required: 5, available: retained.length };

  const previousHostId = room.hostId;
  const previousNarratorId = room.narratorId;
  room.players = retained;
  for (const player of retained) {
    player.role = null;
    player.alive = true;
    player.connected = true;
    player.disconnectAt = null;
    player.eliminatedAt = null;
    player.eliminationKind = null;
    player.privateResults = [];
    player.undertakerUsed = false;
    player.roleActiveFromRound = 1;
  }

  room.hostId = retained.some((player) => player.id === previousHostId)
    ? previousHostId
    : retained[0].id;
  room.hostGraceUntil = null;
  room.narratorId = room.gameMode === 'in_person'
    ? (retained.some((player) => player.id === previousNarratorId) ? previousNarratorId : room.hostId)
    : null;
  room.narratorReadyId = null;
  room.narratorPausedAt = null;
  room.status = 'lobby';
  room.phase = 'lobby';
  room.round = 0;
  room.phaseEndsAt = null;
  room.phaseMinUntil = null;
  room.nightStep = null;
  room.nightStepMinUntil = null;
  room.nightCue = null;
  room.identityReady = {};
  room.actions = freshActions();
  room.tieCandidates = [];
  room.transition = null;
  room.voteReveal = null;
  room.mafiaConflictExtensionUsed = false;
  room.inPersonMafiaTargetId = null;
  room.angelLastProtectedTargetId = null;
  room.winner = null;
  room.finishedAt = null;
  room.lastDeathAnnouncement = null;
  room.chat = [];
  room.clockQuarantined = false;
  room.announcement = makeAnnouncement(
    'welcome',
    'THE TABLE GATHERS AGAIN',
    'The final verdict has faded. The same guests may take their seats for a new game.',
    'gold',
  );
  room.lastActivityAt = now;
  return { ok: true, retainedCount: retained.length, hostId: room.hostId, narratorId: room.narratorId };
}
