import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UNDERTAKER_MAX_PER_GAME,
  UNDERTAKER_RECOMMENDED_MIN_PLAYERS,
  isRoleActive,
  getUndertakerCandidates,
  canUndertakerAct,
  resolveUndertakerChoice,
  toUndertakerPrivateOptions,
} from './undertakerRules.js';

const undertaker = (overrides = {}) => ({ id: 'u', role: 'undertaker', alive: true, undertakerUsed: false, ...overrides });

test('Undertaker is optional, unique, and merely recommended from nine players', () => {
  assert.equal(UNDERTAKER_MAX_PER_GAME, 1);
  assert.equal(UNDERTAKER_RECOMMENDED_MIN_PLAYERS, 9);
});

test('role inherited at night N becomes active at night N+1, not earlier', () => {
  const player = { role: 'mafia', roleActiveFromRound: 4 };
  assert.equal(isRoleActive(player, 3), false);
  assert.equal(isRoleActive(player, 4), true);
  assert.equal(isRoleActive({ role: 'sheriff' }, 1), true);
});

test('graveyard contains gameplay-eliminated copyable identities only', () => {
  const candidates = getUndertakerCandidates([
    { id: 'a', name: 'A', avatar: 'raven', alive: false, role: 'mafia' },
    { id: 'b', name: 'B', avatar: 'owl', alive: false, role: 'sheriff' },
    { id: 'c', name: 'C', avatar: 'bat', alive: false, role: 'undertaker' },
    { id: 'd', name: 'D', avatar: 'cat', alive: false, role: 'citizen', eliminationKind: 'departure' },
    { id: 'e', name: 'E', avatar: 'crow', alive: true, role: 'angel' },
  ]);
  assert.deepEqual(candidates.map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(candidates[0], { id: 'a', name: 'A', avatar: 'raven', role: 'mafia' });
});

test('Undertaker action is unavailable in round one, after use, while dead, or without a graveyard', () => {
  const options = [{ id: 'dead', role: 'mafia' }];
  assert.equal(canUndertakerAct(undertaker(), 1, options), false);
  assert.equal(canUndertakerAct(undertaker({ undertakerUsed: true }), 2, options), false);
  assert.equal(canUndertakerAct(undertaker({ alive: false }), 2, options), false);
  assert.equal(canUndertakerAct(undertaker(), 2, []), false);
  assert.equal(canUndertakerAct(undertaker(), 2, options), true);
});

test('Online Undertaker action is available inside the existing simultaneous night window', () => {
  const options = [{ id: 'dead', role: 'citizen' }];
  assert.equal(canUndertakerAct(undertaker(), 2, options, { gameMode: 'online', nightStep: null }), true);
  assert.equal(canUndertakerAct(undertaker(), 2, options, { phase: 'discussion', gameMode: 'online' }), false);
});

test('In-Person Undertaker action is accepted only during its private step', () => {
  const options = [{ id: 'dead', role: 'citizen' }];
  assert.equal(canUndertakerAct(undertaker(), 2, options, { gameMode: 'in_person', nightStep: 'sheriff' }), false);
  assert.equal(canUndertakerAct(undertaker(), 2, options, { gameMode: 'in_person', nightStep: 'undertaker' }), true);
});

test('accepting one graveyard identity consumes the power and activates the copied role next round', () => {
  const result = resolveUndertakerChoice(undertaker(), { id: 'dead', alive: false, role: 'angel' }, 5);
  assert.deepEqual(result, { ok: true, inheritedRole: 'angel', activeFromRound: 6, used: true });
});

test('Undertaker cannot copy another Undertaker or use a second identity', () => {
  assert.deepEqual(resolveUndertakerChoice(undertaker(), { id: 'dead', alive: false, role: 'undertaker' }, 2), { ok: false, reason: 'identity-unavailable' });
  assert.deepEqual(resolveUndertakerChoice(undertaker({ undertakerUsed: true }), { id: 'dead', alive: false, role: 'mafia' }, 2), { ok: false, reason: 'power-unavailable' });
});


test('all supported departed roles can be inherited once', () => {
  for (const role of ['mafia', 'angel', 'sheriff', 'citizen']) {
    const result = resolveUndertakerChoice(undertaker(), { id: `dead-${role}`, alive: false, role }, 2);
    assert.equal(result.ok, true, `${role} should be copyable`);
    assert.equal(result.inheritedRole, role);
    assert.equal(result.activeFromRound, 3);
  }
});

test('identity transfer rejects living players and players who abandoned the table', () => {
  assert.deepEqual(resolveUndertakerChoice(undertaker(), { id: 'living', alive: true, role: 'mafia' }, 2), { ok: false, reason: 'identity-unavailable' });
  assert.deepEqual(resolveUndertakerChoice(undertaker(), { id: 'left', alive: false, eliminationKind: 'departure', role: 'sheriff' }, 2), { ok: false, reason: 'identity-unavailable' });
});


test('graveyard options sent to the Undertaker omit the inherited role', () => {
  const options = toUndertakerPrivateOptions([
    { id: 'dead-1', name: 'Raven', avatar: 'raven', role: 'mafia' },
  ]);
  assert.deepEqual(options, [{ id: 'dead-1', name: 'Raven', avatar: 'raven' }]);
  assert.equal(Object.hasOwn(options[0], 'role'), false);
});
