const NIGHT_STEP_CLIPS = Object.freeze({
  role_reveal: 'role_reveal',
  town_sleep: 'town_sleep',
  mafia: 'mafia_awaken',
  mafia_clash: 'mafia_clash',
  mafia_sleep: 'mafia_sleep',
  angel: 'angel_awaken',
  angel_sleep: 'angel_sleep',
  sheriff: 'sheriff_awaken',
  sheriff_sleep: 'sheriff_sleep',
  // Exactly one Undertaker call; no public sleep/result/selection clip exists.
  undertaker: 'undertaker_awaken',
  town_wake: 'town_wake',
});

const ANNOUNCEMENT_CLIPS = Object.freeze({
  murder: 'murder_report',
  quiet: 'quiet_report',
  elimination: 'elimination_report',
  'no-elimination': 'no_elimination',
  departure: 'departure_report',
  tie: 'tie_announcement',
  victory: null,
});

/** Return the single public narration event represented by the current server snapshot. */
export function getNarrationCue(snapshot) {
  if (!snapshot || snapshot.gameMode !== 'in_person' || snapshot.status === 'lobby') return null;

  if (snapshot.status === 'finished') {
    const clip = snapshot.winner === 'mafia' ? 'mafia_victory' : 'town_victory';
    return snapshot.announcement?.id ? { key: `announcement:${snapshot.announcement.id}`, clip } : null;
  }

  if (snapshot.phase === 'night' && snapshot.nightCue) {
    const clip = NIGHT_STEP_CLIPS[snapshot.nightStep];
    if (clip) return { key: `night:${snapshot.nightCue.cueId || snapshot.nightCue.id}`, clip };
  }

  // The tie verdict is narrated during its cinematic transition. The actual
  // re-vote receives a second, distinct cue when tieVoting opens.
  if (snapshot.phase === 'tieVoting') {
    return { key: `phase:tieVoting:${snapshot.round}:${(snapshot.tieCandidates || []).map((item) => item.id).join(',')}`, clip: 'tie_voting' };
  }

  const announcement = snapshot.announcement;
  if (announcement?.id && Object.hasOwn(ANNOUNCEMENT_CLIPS, announcement.kind)) {
    if (announcement.kind === 'victory') {
      const clip = snapshot.winner === 'mafia' ? 'mafia_victory' : 'town_victory';
      return { key: `announcement:${announcement.id}`, clip };
    }
    const clip = ANNOUNCEMENT_CLIPS[announcement.kind];
    if (clip) return { key: `announcement:${announcement.id}`, clip };
  }

  if (snapshot.phase === 'discussion') {
    return { key: `phase:discussion:${snapshot.round}`, clip: 'day_discussion' };
  }
  if (snapshot.phase === 'voting') {
    return { key: `phase:voting:${snapshot.round}`, clip: 'voting_begins' };
  }
  return null;
}
