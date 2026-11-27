/** Shared, deterministic rules for the optional Undertaker role. */
export const UNDERTAKER_MAX_PER_GAME = 1;
export const UNDERTAKER_RECOMMENDED_MIN_PLAYERS = 9;
export const UNDERTAKER_COPYABLE_ROLES = Object.freeze(['mafia', 'angel', 'sheriff', 'citizen']);

export function isRoleActive(player, round) {
  if (!player) return false;
  const activeFrom = Number(player.roleActiveFromRound);
  return !Number.isFinite(activeFrom) || activeFrom <= Number(round || 0);
}

/**
 * Graveyard identities are actual gameplay eliminations only. A player who
 * abandoned the game is not an identity that can be inherited. Undertakers
 * are excluded to prevent chaining or duplicating the one-use power.
 */
export function getUndertakerCandidates(players) {
  const copyable = new Set(UNDERTAKER_COPYABLE_ROLES);
  return (Array.isArray(players) ? players : [])
    .filter((player) => player && player.alive === false && player.eliminationKind !== 'departure'
      && copyable.has(player.role))
    .map((player) => ({ id: player.id, name: player.name, avatar: player.avatar, role: player.role }));
}

/** Strip role information before sending the graveyard list to the Undertaker's own client. */
export function toUndertakerPrivateOptions(candidates) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(({ id, name, avatar }) => ({ id, name, avatar }));
}

export function canUndertakerAct(player, round, candidates, { phase = 'night', nightStep = null, gameMode = 'online' } = {}) {
  if (!player || !player.alive || player.role !== 'undertaker' || player.undertakerUsed) return false;
  if (!isRoleActive(player, round) || phase !== 'night' || Number(round) < 2 || !Array.isArray(candidates) || candidates.length === 0) return false;
  if (gameMode === 'in_person' && nightStep !== 'undertaker') return false;
  return true;
}

export function resolveUndertakerChoice(player, target, round) {
  if (!player || player.role !== 'undertaker' || player.undertakerUsed) {
    return { ok: false, reason: 'power-unavailable' };
  }
  if (!target || target.alive !== false || target.eliminationKind === 'departure'
    || !UNDERTAKER_COPYABLE_ROLES.includes(target.role)) {
    return { ok: false, reason: 'identity-unavailable' };
  }
  return {
    ok: true,
    inheritedRole: target.role,
    activeFromRound: Number(round) + 1,
    used: true,
  };
}


/** A living inherited Mafia identity waits until its next round before actions activate. */
export function hasPendingMafiaInheritance(players, round) {
  const currentRound = Number(round || 0);
  return (Array.isArray(players) ? players : []).some((player) => player?.alive
    && player.role === 'mafia'
    && Number(player.roleActiveFromRound || 1) > currentRound);
}
