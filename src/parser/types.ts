export type CommandType =
  | 'SEND'
  | 'BALANCE'
  | 'HISTORY'
  | 'CONTACTS'
  | 'ADD_CONTACT'
  | 'HELP'
  | 'CONFIRM'
  | 'UNKNOWN';

export interface ParsedCommand {
  type: CommandType;
  amount?: number;          // GHS (cedis), not pesewas
  recipient?: string;       // contact nickname
  recipientPhone?: string;  // raw Ghana phone number for ad-hoc sends
  confirmValue?: boolean;
  contactName?: string;     // for ADD_CONTACT
  contactPhone?: string;    // for ADD_CONTACT
  raw: string;
}
