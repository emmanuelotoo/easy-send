import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../src/parser/regex';
import { wordsToNumber } from '../src/parser/words';

test('send with digits and "to"', () => {
  const cmd = parseCommand('send 50 to Kojo');
  assert.equal(cmd.type, 'SEND');
  assert.equal(cmd.amount, 50);
  assert.equal(cmd.recipient, 'Kojo');
});

test('send with word amount and currency word', () => {
  const cmd = parseCommand('send fifty cedis paul');
  assert.equal(cmd.type, 'SEND');
  assert.equal(cmd.amount, 50);
  assert.equal(cmd.recipient, 'paul');
});

test('send to raw phone number', () => {
  const cmd = parseCommand('send 30 to 0241234567');
  assert.equal(cmd.type, 'SEND');
  assert.equal(cmd.amount, 30);
  assert.equal(cmd.recipientPhone, '0241234567');
});

test('recipient-first order', () => {
  const cmd = parseCommand('send Kojo 50');
  assert.equal(cmd.type, 'SEND');
  assert.equal(cmd.amount, 50);
  assert.equal(cmd.recipient, 'Kojo');
});

test('decimal amounts', () => {
  const cmd = parseCommand('send 12.50 to ama');
  assert.equal(cmd.amount, 12.5);
});

test('confirmations', () => {
  assert.deepEqual(parseCommand('yes').type, 'CONFIRM');
  assert.equal(parseCommand('yes').confirmValue, true);
  assert.equal(parseCommand('no').confirmValue, false);
});

test('other commands', () => {
  assert.equal(parseCommand('bal').type, 'BALANCE');
  assert.equal(parseCommand('history').type, 'HISTORY');
  assert.equal(parseCommand('contacts').type, 'CONTACTS');
  assert.equal(parseCommand('help').type, 'HELP');
  assert.equal(parseCommand('add contact Ama 0241234567').type, 'ADD_CONTACT');
  assert.equal(parseCommand('gibberish here').type, 'UNKNOWN');
});

test('word numbers', () => {
  assert.equal(wordsToNumber('fifty'), 50);
  assert.equal(wordsToNumber('two hundred'), 200);
  assert.equal(wordsToNumber('one thousand five hundred'), 1500);
  assert.equal(wordsToNumber('twenty-five'), 25);
  assert.equal(wordsToNumber('banana'), null);
});
