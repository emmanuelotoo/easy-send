export interface PaystackRecipient {
  recipient_code: string;
  name: string;
  type: string;
  details: {
    account_number: string;
    bank_code: string;
    bank_name: string;
  };
}

export interface PaystackTransfer {
  reference: string;
  transfer_code: string;
  amount: number; // pesewas
  /** "otp", "pending", "received", "success", "failed", "reversed", "abandoned", "rejected", "blocked" */
  status: string;
  reason: string;
  /** Present on some failures. */
  gateway_response?: string | null;
  failures?: unknown;
}

export interface PaystackBalance {
  currency: string;
  balance: number; // pesewas
}

export interface PaystackBank {
  name: string;
  code: string;
  type: string;
}

export interface PaystackCharge {
  reference: string;
  /** "send_otp", "pay_offline", "pending", "success", "failed" */
  status: string;
  /** Instruction for the payer, e.g. "Please enter the OTP sent to your phone". */
  display_text?: string | null;
  gateway_response?: string | null;
  message?: string | null;
}

export interface PaystackAccountResolution {
  account_number: string;
  account_name: string;
}
