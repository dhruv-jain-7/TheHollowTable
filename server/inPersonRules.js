/**
 * Pure rules used by the In-Person flow. Keeping these outside index.js makes
 * the timing and Mafia-resolution rules deterministic and independently testable.
 */
export const IN_PERSON_NIGHT_STEP_SECONDS = Object.freeze({
  role_reveal: 45,
  town_sleep: 5,
  mafia: 60,
  mafia_clash: 15,
  mafia_sleep: 5,
  angel: 30,
  angel_sleep: 5,
  sheriff: 30,
  sheriff_sleep: 5,
  town_wake: 5,
});

export const IN_PERSON_NIGHT_STEP_MINIMUM_SECONDS = Object.freeze({
  // Keep the server from advancing past a public spoken cue before it has time to finish.
  role_reveal: 12,
  mafia: 11,
  mafia_clash: 11,
  angel: 11,
  sheriff: 10,
});

export const IN_PERSON_VOTE_SECONDS = 30;

export function getInPersonDiscussionSeconds(livingPlayerCount) {
  const count = Number.isFinite(Number(livingPlayerCount)) ? Math.max(0, Number(livingPlayerCount)) : 0;
  return Math.min(600, Math.max(120, Math.floor(count * 45)));
}

/**
 * Return the current submitted-target tally without making a decision before
 * every connected living Mafia has had an opportunity to submit.
 * Disconnected living Mafia votes already submitted still count; disconnected
 * players who have not submitted do not hold the table hostage.
 */
export function getInPersonMafiaDecision(votes, livingMafiaIds, connectedMafiaIds, livingTargetIds) {
  const livingMafia = new Set(livingMafiaIds ?? []);
  const connectedMafia = [...new Set(connectedMafiaIds ?? [])].filter((id) => livingMafia.has(id));
  const livingTargets = new Set(livingTargetIds ?? []);
  const counts = new Map();
  const submittedVoters = new Set();

  for (const playerId of livingMafia) {
    const targetId = votes?.[playerId];
    if (typeof targetId !== 'string' || !livingTargets.has(targetId)) continue;
    submittedVoters.add(playerId);
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }

  const highScore = counts.size ? Math.max(...counts.values()) : 0;
  const leaders = highScore
    ? [...counts.entries()].filter(([, count]) => count === highScore).map(([id]) => id)
    : [];
  const submittedConnected = connectedMafia.filter((id) => submittedVoters.has(id)).length;
  const allConnectedSubmitted = connectedMafia.length === submittedConnected;
  // A single most-popular target is not enough: Mafia must agree unanimously.
  // Disconnected Mafias who already submitted remain part of that agreement;
  // disconnected players who never submitted cannot hold the live table open.
  const conflict = counts.size > 1;
  const consensusTargetId = connectedMafia.length > 0
    && allConnectedSubmitted
    && counts.size === 1
    ? [...counts.keys()][0]
    : null;

  return {
    submitted: submittedConnected,
    required: connectedMafia.length,
    allConnectedSubmitted,
    hasVotes: counts.size > 0,
    tied: leaders.length > 1,
    conflict,
    winnerId: consensusTargetId,
    consensusTargetId,
    leaders,
    counts: Object.fromEntries(counts),
  };
}

/**
 * Decide whether the sequential Mafia phase can advance. A disagreement gets
 * one 15-second clash window; a lasting disagreement, or an incomplete choice
 * at the deadline, produces no murder rather than a random/majority target.
 */
export function getInPersonMafiaStepOutcome(step, decision, { timedOut = false } = {}) {
  if (!decision || !['mafia', 'mafia_clash'].includes(step)) return null;

  if (step === 'mafia_clash') {
    if (decision.required === 0) return { nextStep: 'mafia_sleep', targetId: null, reason: 'no-connected-mafia' };
    if (decision.consensusTargetId) {
      return { nextStep: 'mafia_sleep', targetId: decision.consensusTargetId, reason: 'consensus' };
    }
    if (timedOut) return { nextStep: 'mafia_sleep', targetId: null, reason: 'unresolved-clash' };
    return null;
  }

  if (decision.consensusTargetId) {
    return { nextStep: 'mafia_sleep', targetId: decision.consensusTargetId, reason: 'consensus' };
  }
  if (decision.required === 0) {
    return { nextStep: 'mafia_sleep', targetId: null, reason: 'no-connected-mafia' };
  }
  if (decision.allConnectedSubmitted && decision.conflict) {
    return { nextStep: 'mafia_clash', targetId: null, reason: 'disagreement' };
  }
  if (timedOut) {
    return decision.conflict
      ? { nextStep: 'mafia_clash', targetId: null, reason: 'deadline-disagreement' }
      : { nextStep: 'mafia_sleep', targetId: null, reason: 'incomplete-choice' };
  }
  return null;
}

export function getInPersonNextNightStep(step, {
  hasConnectedMafia = false,
  hasConnectedAngel = false,
  hasConnectedSheriff = false,
} = {}) {
  const next = {
    role_reveal: 'town_sleep',
    town_sleep: hasConnectedMafia ? 'mafia' : 'mafia_sleep',
    mafia: 'mafia_sleep',
    mafia_clash: 'mafia_sleep',
    mafia_sleep: hasConnectedAngel ? 'angel' : 'angel_sleep',
    angel: 'angel_sleep',
    angel_sleep: hasConnectedSheriff ? 'sheriff' : 'sheriff_sleep',
    sheriff: 'sheriff_sleep',
    sheriff_sleep: 'town_wake',
    town_wake: null,
  };
  return Object.hasOwn(next, step) ? next[step] : null;
}

export function inPersonRoleStep(role) {
  if (role === 'mafia') return ['mafia', 'mafia_clash'];
  if (role === 'angel') return ['angel'];
  if (role === 'sheriff') return ['sheriff'];
  return [];
}

export function allConnectedPlayersReady(playerIds, readyMap) {
  const ids = [...new Set(playerIds ?? [])];
  return ids.length > 0 && ids.every((id) => Boolean(readyMap?.[id]));
}
