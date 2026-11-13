export function canTargetSelf(role) {
  return role === 'angel';
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

export function chooseMafiaTarget(votes, livingPlayerIds) {
  const eligible = new Set(livingPlayerIds);
  const { leaders } = countVotes(votes, eligible);
  return leaders.length === 1 ? leaders[0] : null;
}

export function resolveVote(votes, allowedTargets = null, isTieBreak = false) {
  const { leaders } = countVotes(votes, allowedTargets);
  if (leaders.length === 1) return { type: 'eliminate', targetId: leaders[0], candidates: [] };
  if (!isTieBreak && leaders.length > 1) return { type: 'tie', targetId: null, candidates: leaders };
  return { type: 'none', targetId: null, candidates: [] };
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
  const mafiaDone = livingMafia.every((p) => room.actions.mafiaVotes[p.id]);
  const sheriffDone = !sheriff || Boolean(room.actions.sheriffTarget);
  const angelDone = !angel || Boolean(room.actions.angelTarget);
  return { mafiaDone, sheriffDone, angelDone, allDone: mafiaDone && sheriffDone && angelDone };
}
