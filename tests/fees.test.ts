import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChargeAmount, TRANSFER_FEE_PESEWAS, CHARGE_FEE_RATE } from '../src/payment/fees';

test('charge covers deficit, transfer fee, and collection cut', () => {
  // GHS 50 deficit
  const charge = computeChargeAmount(5000);
  const netAfterCollection = charge * (1 - CHARGE_FEE_RATE);
  assert.ok(netAfterCollection >= 5000 + TRANSFER_FEE_PESEWAS, 'net credit must cover deficit + transfer fee');
});

test('charge is biased high, never under', () => {
  for (const deficit of [1, 99, 100, 2500, 5000, 19900, 50000]) {
    const charge = computeChargeAmount(deficit);
    const net = Math.floor(charge * (1 - CHARGE_FEE_RATE));
    assert.ok(net >= deficit + TRANSFER_FEE_PESEWAS, `deficit ${deficit}: net ${net} too low`);
  }
});

test('non-positive deficit (balance covers amount but not fee) still yields a positive charge', () => {
  assert.ok(computeChargeAmount(0) > 0);
  assert.ok(computeChargeAmount(-50) > 0);
});
