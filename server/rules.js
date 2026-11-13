export function canTargetSelf(role) {
  return role === 'angel' || role === 'mafia';
}

export function getMafiaCap(playerCount) {
  return Math.max(1, Math.floor((playerCount - 1) / 2));
}

export function getDiscussionSeconds(round) {
  if (round <= 2) return 10 * 60;
  if (round <= 4) return 7.5 * 60;
  if (round <= 6) return 6 * 60;
  return 4 * 60;
}

export function countVotes(votes, allowedTargets = null) {
  const counts = new Map();
  for (const targetId of Object.values(votes ?? {})) {
    if (typeof targetId !== 'string') continue;
    if (allowedTargets && !allowedTargets.has(targetId)) continue;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  if (counts.size === 0) return { leaders: [], highScore: 0, counts };
  const highScore = Math.max(...counts.values());
  const leaders = [...counts.entries()]
    .filter(([, count]) => count === highScore)
    .map(([id]) => id);
  return { leaders, highScore, counts };
}

export function chooseMafiaTarget(votes, livingPlayerIds, livingMafiaIds = Object.keys(votes ?? {})) {
  const eligibleTargets = new Set(livingPlayerIds);
  const requiredVoters = [...livingMafiaIds];
  if (requiredVoters.length === 0) return null;

  const selections = requiredVoters.map((playerId) => votes?.[playerId]);
  if (selections.some((targetId) => typeof targetId !== 'string' || !eligibleTargets.has(targetId))) return null;

  const agreedTarget = selections[0];
  return selections.every((targetId) => targetId === agreedTarget) ? agreedTarget : null;
}

export function resolveVote(votes, allowedTargets = null, isTieBreak = false) {
  const { leaders } = countVotes(votes, allowedTargets);
  if (leaders.length === 1) return { type: 'eliminate', targetId: leaders[0], candidates: [] };
  if (!isTieBreak && leaders.length > 1) return { type: 'tie', targetId: null, candidates: leaders };
  return { type: 'none', targetId: null, candidates: [] };
}

export function allPlayersReady(playerIds, readyMap) {
  return playerIds.length > 0 && playerIds.every((id) => Boolean(readyMap?.[id]));
}

export function allPlayersVoted(playerIds, votes) {
  return playerIds.length > 0 && playerIds.every((id) => typeof votes?.[id] === 'string');
}

export function getWinner(players) {
  const alive = players.filter((player) => player.alive);
  const mafia = alive.filter((player) => player.role === 'mafia').length;
  const town = alive.length - mafia;
  if (mafia === 0) return 'town';
  if (mafia >= town) return 'mafia';
  return null;
}

export function getNightActionProgress(room) {
  const livingMafia = room.players.filter((p) => p.alive && p.role === 'mafia');
  const sheriff = room.players.find((p) => p.alive && p.role === 'sheriff');
  const angel = room.players.find((p) => p.alive && p.role === 'angel');
  const mafiaVotes = room.actions.mafiaVotes ?? {};
  const mafiaSubmitted = livingMafia.filter((p) => typeof mafiaVotes[p.id] === 'string').length;
  const mafiaTargets = livingMafia.map((p) => mafiaVotes[p.id]).filter(Boolean);
  const mafiaDone = livingMafia.length > 0
    && mafiaSubmitted === livingMafia.length
    && new Set(mafiaTargets).size === 1;
  const sheriffDone = !sheriff || Boolean(room.actions.sheriffTarget);
  const angelDone = !angel || Boolean(room.actions.angelTarget);
  return {
    mafiaDone,
    mafiaSubmitted,
    mafiaRequired: livingMafia.length,
    sheriffDone,
    angelDone,
    allDone: mafiaDone && sheriffDone && angelDone,
  };
}
