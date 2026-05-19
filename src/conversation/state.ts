import { config } from '../config';

export interface PendingTransfer {
  /** Contact id, or null for ad-hoc raw-phone sends */
  contactId: number | null;
  contactNickname: string;
  phone: string;
  recipientCode: string | null;
  amountGHS: number;
  amountPesewas: number;
  reference: string;
}

type ConversationState = 'IDLE' | 'AWAITING_CONFIRMATION';

interface State {
  current: ConversationState;
  pendingTransfer: PendingTransfer | null;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
}

const state: State = {
  current: 'IDLE',
  pendingTransfer: null,
  timeoutHandle: null,
};

export function getPendingTransfer(): PendingTransfer | null {
  return state.pendingTransfer;
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

export function clearPending(): void {
  if (state.timeoutHandle) {
    clearTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }
  state.current = 'IDLE';
  state.pendingTransfer = null;
}

export function isAwaitingConfirmation(): boolean {
  return state.current === 'AWAITING_CONFIRMATION';
}
