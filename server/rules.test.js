import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDiscussionSeconds,
  getMafiaCap,
  countVotes,
  chooseMafiaTarget,
  resolveVote,
  getWinner,
  getNightActionProgress,
  canTargetSelf,
  allPlayersReady,
  allPlayersVoted,
} from './rules.js';

test('discussion clock follows the round schedule and never drops below four minutes', () => {
  assert.equal(getDiscussionSeconds(1), 600);
  assert.equal(getDiscussionSeconds(2), 600);
  assert.equal(getDiscussionSeconds(3), 450);
  assert.equal(getDiscussionSeconds(4), 450);
  assert.equal(getDiscussionSeconds(5), 360);
  assert.equal(getDiscussionSeconds(6), 360);
  assert.equal(getDiscussionSeconds(7), 240);
  assert.equal(getDiscussionSeconds(30), 240);
});

test('mafia cap always leaves at least one more non-mafia player', () => {
  assert.equal(getMafiaCap(5), 2);
  assert.equal(getMafiaCap(8), 3);
  assert.equal(getMafiaCap(16), 7);
});

test('vote counting handles ties and ignores invalid targets', () => {
  const result = countVotes({ a: 'x', b: 'y', c: 'x', d: null }, new Set(['x', 'y']));
  assert.deepEqual(result.leaders, ['x']);
  assert.equal(result.highScore, 2);
});

test('Mafia must unanimously choose one living target', () => {
  assert.equal(chooseMafiaTarget({ m1: 'p1', m2: 'p1' }, ['p1', 'p2'], ['m1', 'm2']), 'p1');
  assert.equal(chooseMafiaTarget({ m1: 'p1', m2: 'p2' }, ['p1', 'p2'], ['m1', 'm2']), null);
  assert.equal(chooseMafiaTarget({ m1: 'p1' }, ['p1', 'p2'], ['m1', 'm2']), null);
  assert.equal(chooseMafiaTarget({ m1: 'p1', m2: 'dead' }, ['p1', 'p2'], ['m1', 'm2']), null);
  assert.equal(chooseMafiaTarget({ m1: 'm1' }, ['m1', 'p2'], ['m1']), 'm1');
});

test('a first-round tie opens a tie-break; a second tie eliminates nobody', () => {
  const first = resolveVote({ a: 'x', b: 'y', c: 'x', d: 'y' });
  assert.equal(first.type, 'tie');
  assert.deepEqual(new Set(first.candidates), new Set(['x', 'y']));
  const second = resolveVote({ a: 'x', b: 'y', c: 'x', d: 'y' }, new Set(['x', 'y']), true);
  assert.equal(second.type, 'none');
});

test('a tie-break can still produce one elimination and excludes non-candidates', () => {
  const result = resolveVote({ a: 'x', b: 'x', c: 'outside', d: 'y' }, new Set(['x', 'y']), true);
  assert.equal(result.type, 'eliminate');
  assert.equal(result.targetId, 'x');
});

test('night actions finish only after Mafia agree and Sheriff and Angel act', () => {
  const room = {
    players: [
      { id: 'm1', role: 'mafia', alive: true },
      { id: 'm2', role: 'mafia', alive: true },
      { id: 's', role: 'sheriff', alive: true },
      { id: 'a', role: 'angel', alive: true },
      { id: 'c', role: 'citizen', alive: true },
    ],
    actions: { mafiaVotes: { m1: 'c' }, sheriffTarget: 'm1', angelTarget: null },
  };
  assert.equal(getNightActionProgress(room).allDone, false);
  room.actions.mafiaVotes.m2 = 's';
  room.actions.angelTarget = 'c';
  assert.equal(getNightActionProgress(room).allDone, false);
  room.actions.mafiaVotes.m2 = 'c';
  assert.equal(getNightActionProgress(room).allDone, true);
});

test('every living player must be ready before discussion ends early', () => {
  assert.equal(allPlayersReady(['p1', 'p2', 'p3'], { p1: true, p2: true }), false);
  assert.equal(allPlayersReady(['p1', 'p2', 'p3'], { p1: true, p2: true, p3: true }), true);
  assert.equal(allPlayersReady([], {}), false);
});

test('voting completes after every living player submits a vote', () => {
  assert.equal(allPlayersVoted(['p1', 'p2'], { p1: 'p3' }), false);
  assert.equal(allPlayersVoted(['p1', 'p2'], { p1: 'p3', p2: 'p1' }), true);
  assert.equal(allPlayersVoted([], {}), false);
});

test('victory detection handles town win, mafia parity, and continuing games', () => {
  assert.equal(getWinner([{ alive: true, role: 'citizen' }, { alive: true, role: 'sheriff' }]), 'town');
  assert.equal(getWinner([{ alive: true, role: 'mafia' }, { alive: true, role: 'citizen' }]), 'mafia');
  assert.equal(getWinner([
    { alive: true, role: 'mafia' },
    { alive: true, role: 'citizen' },
    { alive: true, role: 'angel' },
  ]), null);
});

test('Mafia and Angel may choose themselves as a night target', () => {
  assert.equal(canTargetSelf('angel'), true);
  assert.equal(canTargetSelf('mafia'), true);
  assert.equal(canTargetSelf('sheriff'), false);
  assert.equal(canTargetSelf('citizen'), false);
});

test('Mafia consensus permits friendly fire against another living Mafia member', () => {
  assert.equal(chooseMafiaTarget({ mafiaOne: 'mafiaTwo' }, ['mafiaOne', 'mafiaTwo', 'citizen']), 'mafiaTwo');
});
