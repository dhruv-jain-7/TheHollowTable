import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IN_PERSON_NIGHT_STEP_SECONDS,
  IN_PERSON_VOTE_SECONDS,
  getInPersonDiscussionSeconds,
  getInPersonMafiaDecision,
  getInPersonMafiaStepOutcome,
  getInPersonNextNightStep,
  inPersonRoleStep,
  allConnectedPlayersReady,
} from './inPersonRules.js';

test('In-Person action windows are bounded and match the table sequence', () => {
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.mafia, 60);
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.mafia_clash, 15);
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.angel, 30);
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.sheriff, 30);
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.undertaker, 30);
  assert.equal(IN_PERSON_NIGHT_STEP_SECONDS.role_reveal, 45);
  assert.equal(IN_PERSON_VOTE_SECONDS, 30);
});

test('In-Person discussion scales with living players and stays within 2 to 10 minutes', () => {
  assert.equal(getInPersonDiscussionSeconds(0), 120);
  assert.equal(getInPersonDiscussionSeconds(5), 225);
  assert.equal(getInPersonDiscussionSeconds(8), 360);
  assert.equal(getInPersonDiscussionSeconds(12), 540);
  assert.equal(getInPersonDiscussionSeconds(16), 600);
  assert.equal(getInPersonDiscussionSeconds(100), 600);
});

test('Mafia decision waits for every connected living Mafia before early resolution', () => {
  const result = getInPersonMafiaDecision(
    { m1: 'p1' },
    ['m1', 'm2'],
    ['m1', 'm2'],
    ['m1', 'm2', 'p1', 'p2'],
  );
  assert.equal(result.submitted, 1);
  assert.equal(result.required, 2);
  assert.equal(result.allConnectedSubmitted, false);
  assert.equal(result.winnerId, null);
  assert.equal(result.consensusTargetId, null);
  assert.equal(result.tied, false);
  assert.equal(result.conflict, false);
});

test('Mafia decision detects a tied top choice and never picks randomly', () => {
  const result = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p2' },
    ['m1', 'm2'],
    ['m1', 'm2'],
    ['m1', 'm2', 'p1', 'p2'],
  );
  assert.equal(result.allConnectedSubmitted, true);
  assert.equal(result.tied, true);
  assert.equal(result.winnerId, null);
  assert.deepEqual(new Set(result.leaders), new Set(['p1', 'p2']));
});

test('Mafia decision treats a leading plurality as disagreement, not consensus', () => {
  const result = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p1', m3: 'p2' },
    ['m1', 'm2', 'm3'],
    ['m1', 'm2', 'm3'],
    ['m1', 'm2', 'm3', 'p1', 'p2'],
  );
  assert.equal(result.allConnectedSubmitted, true);
  assert.equal(result.winnerId, null);
  assert.equal(result.conflict, true);
  assert.equal(result.tied, false);
});

test('a disconnected Mafia who never acted does not hold up the remaining living Mafia', () => {
  const result = getInPersonMafiaDecision(
    { m1: 'p1' },
    ['m1', 'm2'],
    ['m1'],
    ['m1', 'm2', 'p1', 'p2'],
  );
  assert.equal(result.required, 1);
  assert.equal(result.submitted, 1);
  assert.equal(result.allConnectedSubmitted, true);
  assert.equal(result.winnerId, 'p1');
  assert.equal(result.consensusTargetId, 'p1');
});

test('Mafia resolution ignores dead voters and dead or invalid targets', () => {
  const result = getInPersonMafiaDecision(
    { m1: 'dead-target', m2: 'p1', eliminatedMafia: 'p2', stranger: 'p2' },
    ['m1', 'm2'],
    ['m1', 'm2'],
    ['m1', 'm2', 'p1'],
  );
  assert.equal(result.submitted, 1);
  assert.equal(result.allConnectedSubmitted, false);
  assert.equal(result.winnerId, null);
  assert.equal(result.conflict, false);
});

test('role-action permissions map only to the intended sequential step', () => {
  assert.deepEqual(inPersonRoleStep('mafia'), ['mafia', 'mafia_clash']);
  assert.deepEqual(inPersonRoleStep('angel'), ['angel']);
  assert.deepEqual(inPersonRoleStep('sheriff'), ['sheriff']);
  assert.deepEqual(inPersonRoleStep('undertaker'), ['undertaker']);
  assert.deepEqual(inPersonRoleStep('citizen'), []);
});

test('identity barrier ignores disconnected seats and requires at least one connected player', () => {
  assert.equal(allConnectedPlayersReady(['p1', 'p2'], { p1: true }), false);
  assert.equal(allConnectedPlayersReady(['p1', 'p2'], { p1: true, p2: true }), true);
  assert.equal(allConnectedPlayersReady(['p1'], { p1: false }), false);
  assert.equal(allConnectedPlayersReady([], {}), false);
});


test('a unanimous decision advances as soon as all connected Mafias submit', () => {
  const decision = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p1' }, ['m1', 'm2'], ['m1', 'm2'], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia', decision), {
    nextStep: 'mafia_sleep', targetId: 'p1', reason: 'consensus',
  });
});

test('a tied or split Mafia choice opens the single clash window', () => {
  const decision = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p2', m3: 'p1' }, ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3', 'p1', 'p2'],
  );
  assert.equal(decision.tied, false);
  assert.equal(decision.conflict, true);
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia', decision), {
    nextStep: 'mafia_clash', targetId: null, reason: 'disagreement',
  });
});

test('a Mafia deadline never converts an incomplete plurality into a murder', () => {
  const decision = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p1' }, ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3'], ['m1', 'm2', 'm3', 'p1', 'p2'],
  );
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia', decision, { timedOut: true }), {
    nextStep: 'mafia_sleep', targetId: null, reason: 'incomplete-choice',
  });
});

test('an unresolved clash expires into no murder, while consensus seals a target', () => {
  const split = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p2' }, ['m1', 'm2'], ['m1', 'm2'], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia_clash', split, { timedOut: true }), {
    nextStep: 'mafia_sleep', targetId: null, reason: 'unresolved-clash',
  });
  const agreed = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p1' }, ['m1', 'm2'], ['m1', 'm2'], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia_clash', agreed), {
    nextStep: 'mafia_sleep', targetId: 'p1', reason: 'consensus',
  });
});

test('a disconnected Mafia who never submitted cannot block consensus, but their submitted disagreement still counts', () => {
  const disconnectedNoVote = getInPersonMafiaDecision(
    { m1: 'p1' }, ['m1', 'm2'], ['m1'], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.equal(disconnectedNoVote.winnerId, 'p1');

  const disconnectedDifferentVote = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p2' }, ['m1', 'm2'], ['m1'], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.equal(disconnectedDifferentVote.winnerId, null);
  assert.equal(disconnectedDifferentVote.conflict, true);
});


test('public night sequence always calls Angel, Sheriff and Undertaker in the same order', () => {
  assert.equal(getInPersonNextNightStep('role_reveal'), 'town_sleep');
  assert.equal(getInPersonNextNightStep('town_sleep'), 'mafia');
  assert.equal(getInPersonNextNightStep('mafia_sleep'), 'angel');
  assert.equal(getInPersonNextNightStep('angel_sleep'), 'sheriff');
  assert.equal(getInPersonNextNightStep('sheriff_sleep'), 'undertaker');
  assert.equal(getInPersonNextNightStep('undertaker'), 'town_wake');
  assert.equal(getInPersonNextNightStep('town_wake'), null);
});


test('a clash skips immediately when no living Mafia device remains connected', () => {
  const decision = getInPersonMafiaDecision(
    { m1: 'p1', m2: 'p2' }, ['m1', 'm2'], [], ['m1', 'm2', 'p1', 'p2'],
  );
  assert.deepEqual(getInPersonMafiaStepOutcome('mafia_clash', decision), {
    nextStep: 'mafia_sleep', targetId: null, reason: 'no-connected-mafia',
  });
});
