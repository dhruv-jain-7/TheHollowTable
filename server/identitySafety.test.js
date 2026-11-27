import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanChatText, cleanDisplayName, displayNameSkeleton } from './identitySafety.js';

test('display names are NFKC-normalized and format controls are removed', () => {
  assert.equal(cleanDisplayName('  Ａlice\u200B\u202E  '), 'Alice');
});

test('display-name skeleton catches common Greek and Cyrillic lookalikes', () => {
  assert.equal(displayNameSkeleton('Mafia'), displayNameSkeleton('Маfia'));
  assert.equal(displayNameSkeleton('Alice'), displayNameSkeleton('Αlice'));
});

test('chat text is normalized and strips invisible formatting characters', () => {
  assert.equal(cleanChatText('Hello\u200B\u202E world'), 'Hello world');
  assert.equal(cleanChatText('  ＨＥＬＬＯ  '), 'HELLO');
});

test('non-string values are rejected safely', () => {
  assert.equal(cleanDisplayName({}), '');
  assert.equal(cleanChatText(null), '');
});
