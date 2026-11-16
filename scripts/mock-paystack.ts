/**
 * A small stand-in for the Paystack API, for trying the app without real keys
 * and for the test suite. It models just enough behaviour to exercise every
 * path in the transfer state machine.
 *
 * Magic values:
 *   - recipient numbers ending in 9999: the transfer fails after it is accepted
 *   - recipient numbers ending in 0000: the account name cannot be resolved
 *   - OTP 123456 is always the right code
 */
import http from 'http';
import { AddressInfo } from 'net';

interface MockTransfer {
  reference: string;
  transfer_code: string;
  amount: number;
  status: string;
  reason: string;
  recipient: string;
  gateway_response?: string;
}

interface MockCharge {
  reference: string;
  amount: number;
  status: string;
  display_text?: string;
}

export interface MockOptions {
  port?: number;
  /** Starting balance in pesewas. */
  balance?: number;
  /** Milliseconds before a pending transfer or charge settles. */
  settleMs?: number;
}

export interface MockPaystack {
  url: string;
  state: {
    balance: number;
    /** Transfers come back as "otp" and need finalizing. */
    transferOtp: boolean;
    /** Wallet charges ask for an OTP before the phone prompt. */
    chargeOtp: boolean;
    /** Wallet charges settle on their own. Turn off to simulate an ignored prompt. */
    autoApproveCharges: boolean;
    /** Approved charges land in the transfer balance (manual payouts on). */
    creditChargesToBalance: boolean;
    /** The next POST /transfer is processed but answers with a 502. */
    dropNextTransferResponse: boolean;
    transfers: Map<string, MockTransfer>;
    charges: Map<string, MockCharge>;
    recipients: Map<string, { account_number: string; name: string }>;
    requests: string[];
  };
  close(): Promise<void>;
}

const NAMES: Record<string, string> = {
  '0241234567': 'KOJO MENSAH',
  '0551234567': 'AMA SERWAA BOATENG',
  '0201234567': 'ABENA OWUSU',
  '0261234567': 'YAW DARKO',
};

const TRANSFER_FEE = 100;
const COLLECTION_RATE = 0.0195;

export async function startMockPaystack(options: MockOptions = {}): Promise<MockPaystack> {
  const settleMs = options.settleMs ?? 2500;
  const state: MockPaystack['state'] = {
    balance: options.balance ?? 15_000,
    transferOtp: false,
    chargeOtp: false,
    autoApproveCharges: true,
    creditChargesToBalance: true,
    dropNextTransferResponse: false,
    transfers: new Map(),
    charges: new Map(),
    recipients: new Map(),
    requests: [],
  };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let counter = 0;

  function later(fn: () => void): void {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, settleMs);
    timers.add(t);
  }

  function settleTransfer(transfer: MockTransfer): void {
    transfer.status = 'pending';
    later(() => {
      const account = state.recipients.get(transfer.recipient)?.account_number ?? '';
      if (account.endsWith('9999')) {
        transfer.status = 'failed';
        transfer.gateway_response = 'Recipient wallet cannot receive funds';
        state.balance += transfer.amount + TRANSFER_FEE;
      } else {
        transfer.status = 'success';
      }
    });
  }

  function approveCharge(charge: MockCharge): void {
    charge.status = 'pay_offline';
    charge.display_text = 'Approve the payment prompt on your phone to complete this top-up.';
    if (!state.autoApproveCharges) return;
    later(() => {
      charge.status = 'success';
      if (state.creditChargesToBalance) {
        state.balance += Math.floor(charge.amount * (1 - COLLECTION_RATE));
      }
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const route = `${req.method} ${url.pathname}`;
    state.requests.push(route);

    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};

    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (data: unknown, message = 'OK') => send(200, { status: true, message, data });
    const no = (status: number, message: string) => send(status, { status: false, message });

    if (!String(req.headers.authorization ?? '').startsWith('Bearer ')) return no(401, 'No Authorization header');

    if (route === 'GET /balance') return ok([{ currency: 'GHS', balance: state.balance }]);

    if (route === 'GET /bank') {
      return ok([
        { name: 'MTN', code: 'MTN', type: 'mobile_money' },
        { name: 'Telecel Cash', code: 'VOD', type: 'mobile_money' },
        { name: 'AirtelTigo', code: 'ATL', type: 'mobile_money' },
      ]);
    }

    if (route === 'GET /bank/resolve') {
      const number = url.searchParams.get('account_number') ?? '';
      if (number.endsWith('0000')) return no(422, 'Could not resolve account name');
      return ok({ account_number: number, account_name: NAMES[number] ?? 'KWAME ASANTE' });
    }

    if (route === 'POST /transferrecipient') {
      const code = `RCP_mock${++counter}`;
      state.recipients.set(code, { account_number: body.account_number, name: body.name });
      return ok({ recipient_code: code, name: body.name, type: 'mobile_money' });
    }

    if (route === 'POST /transfer') {
      if (state.transfers.has(body.reference)) return no(400, 'Please provide a unique reference');
      if (!state.recipients.has(body.recipient)) return no(400, 'Recipient specified is invalid');
      if (state.balance < body.amount + TRANSFER_FEE) return no(400, 'Your balance is not enough to fulfil this request');

      const transfer: MockTransfer = {
        reference: body.reference,
        transfer_code: `TRF_mock${++counter}`,
        amount: body.amount,
        status: 'pending',
        reason: body.reason,
        recipient: body.recipient,
      };
      state.transfers.set(transfer.reference, transfer);
      state.balance -= body.amount + TRANSFER_FEE;

      if (state.transferOtp) transfer.status = 'otp';
      else settleTransfer(transfer);

      if (state.dropNextTransferResponse) {
        state.dropNextTransferResponse = false;
        return send(502, { status: false, message: 'Bad gateway' });
      }
      return ok(transfer, state.transferOtp ? 'Transfer requires OTP to continue' : 'Transfer has been queued');
    }

    if (route === 'POST /transfer/finalize_transfer') {
      const transfer = [...state.transfers.values()].find(t => t.transfer_code === body.transfer_code);
      if (!transfer || transfer.status !== 'otp') return no(400, 'Transfer is not currently awaiting OTP');
      if (body.otp !== '123456') return no(400, 'OTP could not be verified');
      settleTransfer(transfer);
      return ok(transfer, 'Transfer has been queued');
    }

    const verify = url.pathname.match(/^\/transfer\/verify\/(.+)$/);
    if (req.method === 'GET' && verify) {
      const transfer = state.transfers.get(decodeURIComponent(verify[1]));
      return transfer ? ok(transfer) : no(404, 'Transfer not found');
    }

    if (route === 'POST /charge') {
      if (state.charges.has(body.reference)) return no(400, 'Duplicate Transaction Reference');
      if (!body.mobile_money?.phone || !body.mobile_money?.provider) return no(400, 'Mobile money details are required');
      const charge: MockCharge = { reference: body.reference, amount: body.amount, status: 'pending' };
      state.charges.set(charge.reference, charge);
      if (state.chargeOtp) {
        charge.status = 'send_otp';
        charge.display_text = 'Please enter the one-time password sent to your phone';
      } else {
        approveCharge(charge);
      }
      return ok(charge, 'Charge attempted');
    }

    if (route === 'POST /charge/submit_otp') {
      const charge = state.charges.get(body.reference);
      if (!charge || charge.status !== 'send_otp') return no(400, 'Charge is not awaiting an OTP');
      if (body.otp !== '123456') return no(400, 'Invalid OTP');
      approveCharge(charge);
      return ok(charge, 'Charge attempted');
    }

    const chargeLookup = url.pathname.match(/^\/charge\/(.+)$/);
    if (req.method === 'GET' && chargeLookup) {
      const charge = state.charges.get(decodeURIComponent(chargeLookup[1]));
      return charge ? ok(charge) : no(404, 'Transaction reference not found');
    }

    return no(404, `Mock Paystack has no route for ${route}`);
  });

  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () =>
      new Promise<void>(resolve => {
        timers.forEach(clearTimeout);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
