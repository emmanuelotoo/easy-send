import { config } from '../config';

export interface PendingTransfer {
  contactId: number;
  contactNickname: string;
  phone: string;
  recipientCode: string | null;
  amountGHS: number;
  amountPesewas: number;
  reference: string;
}

export interface PendingCharge {
  chargeReference: string;
  transfer: PendingTransfer;
}

type ConversationState = 'IDLE' | 'AWAITING_CONFIRMATION' | 'AWAITING_VOUCHER';

interface State {
  current: ConversationState;
  pendingTransfer: PendingTransfer | null;
  pendingCharge: PendingCharge | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const state: State = {
  current: 'IDLE',
  pendingTransfer: null,
  pendingCharge: null,
  timeoutHandle: null,
};

export function getState(): ConversationState {
  return state.current;
}

export function getPendingTransfer(): PendingTransfer | null {
  return state.pendingTransfer;
}

export function getPendingCharge(): PendingCharge | null {
  return state.pendingCharge;
}

export function setAwaitingConfirmation(transfer: PendingTransfer, onTimeout: () => void): void {
  clearPending();
  state.current = 'AWAITING_CONFIRMATION';
  state.pendingTransfer = transfer;
  state.timeoutHandle = setTimeout(() => {
    clearPending();
    onTimeout();
  }, config.confirmationTimeoutMs);
}

export function setAwaitingVoucher(charge: PendingCharge, onTimeout: () => void): void {
  // Clear any existing timeout but preserve state transition
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
  }
  state.current = 'AWAITING_VOUCHER';
  state.pendingTransfer = charge.transfer;
  state.pendingCharge = charge;
  state.timeoutHandle = setTimeout(() => {
    clearPending();
    onTimeout();
  }, config.confirmationTimeoutMs);
}

export function clearPending(): void {
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }
  state.current = 'IDLE';
  state.pendingTransfer = null;
  state.pendingCharge = null;
}

export function isAwaitingConfirmation(): boolean {
  return state.current === 'AWAITING_CONFIRMATION';
}

export function isAwaitingVoucher(): boolean {
  return state.current === 'AWAITING_VOUCHER';
}
