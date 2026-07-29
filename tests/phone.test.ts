import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toInternational, toLocal, detectNetwork } from '../src/utils/phone';

test('toInternational normalizes all common formats', () => {
  assert.equal(toInternational('0241234567'), '233241234567');
  assert.equal(toInternational('+233241234567'), '233241234567');
  assert.equal(toInternational('233241234567'), '233241234567');
  assert.equal(toInternational('024 123 4567'), '233241234567');
});

test('toLocal formats for display', () => {
  assert.equal(toLocal('233241234567'), '024 123 4567');
  assert.equal(toLocal('0501234567'), '050 123 4567');
});

test('detectNetwork maps Ghana prefixes', () => {
  assert.equal(detectNetwork('0241234567'), 'mtn');
  assert.equal(detectNetwork('0551234567'), 'mtn');
  assert.equal(detectNetwork('0591234567'), 'mtn');
  assert.equal(detectNetwork('0201234567'), 'telecel');
  assert.equal(detectNetwork('0501234567'), 'telecel');
  assert.equal(detectNetwork('0261234567'), 'airteltigo');
  assert.equal(detectNetwork('0571234567'), 'airteltigo');
  assert.equal(detectNetwork('+233241234567'), 'mtn');
});

test('detectNetwork rejects malformed or unknown numbers', () => {
  assert.equal(detectNetwork('02412345'), null);
  assert.equal(detectNetwork('0991234567'), null);
  assert.equal(detectNetwork('12345'), null);
});
