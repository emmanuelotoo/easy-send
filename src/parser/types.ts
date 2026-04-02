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
  amount?: number;       // in GHS (cedis), not pesewas
  recipient?: string;    // nickname
  confirmValue?: boolean; // true = yes, false = no
  contactName?: string;  // for ADD_CONTACT
  contactPhone?: string; // for ADD_CONTACT
  raw: string;           // original message text
}
