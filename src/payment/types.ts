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
  status: string; // "success", "pending", "failed", "reversed"
  reason: string;
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
  status: string; // "pay_offline", "pending", "success", "failed"
}
