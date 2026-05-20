import { ParsedCommand } from '../parser/types';
import { resolveRecipient, resolveAdhocPhone, ResolvedContact } from '../contacts/resolver';
import { findContactByNickname, getAllContacts, addContact, updateRecipientCode } from '../contacts/store';
import { validateAmount } from '../payment/validator';
import { toPesewas, formatGHS } from '../utils/money';
import { toLocal, toInternational, detectNetwork, networkLabel, Network } from '../utils/phone';
import {
  generateReference,
  getGHSBalance,
  createRecipient as createPaystackRecipient,
  initiateTransfer,
  resolveMomoBankCodes,
  resolveAccountName,
  chargeMobileMoney,
  checkPendingCharge,
} from '../payment/paystack';
import { computeChargeAmount } from '../payment/fees';
import {
  PendingTransfer,
  setAwaitingConfirmation,
  getPendingTransfer,
  clearPending,
} from './state';
import { getDb } from '../db/client';
import { logger } from '../utils/logger';
import { config } from '../config';

let bankCodes: Record<Network, string | null> = { mtn: null, telecel: null, airteltigo: null };

export async function initPaymentProvider(): Promise<void> {
  bankCodes = await resolveMomoBankCodes();
  for (const network of Object.keys(bankCodes) as Network[]) {
    if (!bankCodes[network]) {
      logger.warn('%s bank code not found — transfers to %s will fail until resolved', network, network);
    }
  }
}

export async function handleSend(
  cmd: ParsedCommand,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  if (!cmd.amount || (!cmd.recipient && !cmd.recipientPhone)) {
    await sendReply('Could not parse amount or recipient. Try: *send 50 to Kojo* or *send 30 to 0241234567*');
    return;
  }

  let resolved: ResolvedContact | null;
  if (cmd.recipientPhone) {
    resolved = resolveAdhocPhone(cmd.recipientPhone);
  } else {
    resolved = resolveRecipient(cmd.recipient!);
    if (!resolved) {
      await sendReply(
        `Contact "${cmd.recipient}" not found.\n\nAdd them with:\n*add contact ${cmd.recipient} 024XXXXXXX*\n\nOr send directly: *send ${cmd.amount} to 024XXXXXXX*`
      );
      return;
    }
  }

  const validation = validateAmount(cmd.amount);
  if (!validation.ok) {
    await sendReply(validation.error!);
    return;
  }

  const network = detectNetwork(resolved.phone);
  if (!network) {
    await sendReply(
      `Couldn't recognize the network for that number.\nEasy-Send supports MTN, Telecel, and AirtelTigo numbers.`
    );
    return;
  }

  const bankCode = bankCodes[network];
  if (!bankCode) {
    await sendReply(`Sending to ${networkLabel(network)} isn't available right now. Please try again later.`);
    return;
  }

  const amountPesewas = toPesewas(cmd.amount);
  const reference = generateReference();

  const verifiedName = await resolveAccountName(resolved.phone, bankCode);

  const db = getDb();
  db.prepare(
    `INSERT INTO transactions (contact_id, amount_pesewas, status, paystack_reference, reason)
     VALUES (?, ?, 'pending', ?, ?)`
  ).run(resolved.contact?.id ?? null, amountPesewas, reference, `Send to ${resolved.displayName}`);

  setAwaitingConfirmation(
    {
      contactId: resolved.contact?.id ?? null,
      contactNickname: resolved.displayName,
      phone: resolved.phone,
      network,
      recipientCode: resolved.recipientCode,
      amountGHS: cmd.amount,
      amountPesewas,
      reference,
    },
    async () => {
      await sendReply('Transfer cancelled — confirmation timed out.');
      db.prepare("UPDATE transactions SET status = 'cancelled' WHERE paystack_reference = ?").run(reference);
    }
  );

  const label = networkLabel(network);
  const localPhone = toLocal(resolved.phone);
  let toLine: string;
  let warning = '';
  if (verifiedName) {
    toLine = resolved.contact
      ? `To: ${resolved.displayName} — verified: ${verifiedName} (${localPhone} · ${label})`
      : `To: ${verifiedName} (${localPhone} · ${label})`;
  } else {
    toLine = resolved.contact
      ? `To: ${resolved.displayName} (${localPhone} · ${label})`
      : `To: ${localPhone} · ${label}`;
    warning = `\n⚠️ Couldn't verify the recipient's name — double-check the number.`;
  }

  await sendReply(
    `*Confirm Transfer*\n\n` +
    `${toLine}\n` +
    `Amount: ${formatGHS(amountPesewas)}${warning}\n\n` +
    `Reply *YES* to confirm or *NO* to cancel.`
  );
}

export async function handleConfirmation(
  confirmed: boolean,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const pending = getPendingTransfer();
  if (!pending) {
    await sendReply('Nothing to confirm.');
    return;
  }

  clearPending();
  const db = getDb();

  if (!confirmed) {
    db.prepare("UPDATE transactions SET status = 'cancelled' WHERE paystack_reference = ?").run(pending.reference);
    await sendReply('Transfer cancelled.');
    return;
  }

  try {
    const balancePesewas = await getGHSBalance();
    if (balancePesewas < pending.amountPesewas) {
      await fundAndTransfer(pending, balancePesewas, sendReply);
      return;
    }

    await executeTransfer(pending, sendReply);
  } catch (err: any) {
    logger.error(err, 'Transfer failed');
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(pending.reference);
    await sendReply(`Transfer failed: ${err.message}`);
  }
}

/** Top up Paystack from owner's MTN MoMo wallet, then execute the transfer. */
async function fundAndTransfer(
  pending: PendingTransfer,
  currentBalancePesewas: number,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const deficit = pending.amountPesewas - currentBalancePesewas;
  const chargeAmount = computeChargeAmount(deficit);
  const chargeRef = generateReference();
  const phone = toInternational(config.ownerPhone);
  const db = getDb();

  db.prepare(
    `UPDATE transactions SET charge_reference = ? WHERE paystack_reference = ?`
  ).run(chargeRef, pending.reference);

  await sendReply(
    `Insufficient Paystack balance (${formatGHS(currentBalancePesewas)}).\n` +
    `Charging ${formatGHS(chargeAmount)} from your MTN MoMo wallet.\n` +
    `Approve the prompt on your phone (PIN).`
  );

  try {
    const charge = await chargeMobileMoney(chargeAmount, phone, config.ownerEmail, chargeRef);

    let status = charge.status;
    if (status !== 'success') {
      status = await pollCharge(chargeRef);
    }

    if (status !== 'success') {
      db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(pending.reference);
      await sendReply(
        `Wallet charge did not complete (${status}). Transfer cancelled.\n` +
        `If you approved the prompt, check your MoMo balance and try again.`
      );
      return;
    }

    await sendReply('Wallet charged. Sending now...');
    await executeTransfer(pending, sendReply);
  } catch (err: any) {
    logger.error(err, 'Auto-fund charge failed');
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(pending.reference);
    await sendReply(`Could not charge wallet: ${err.message}`);
  }
}

/** Poll a pending mobile money charge until success/failure or timeout (~90s). */
async function pollCharge(reference: string): Promise<string> {
  const intervalMs = 5000;
  const maxAttempts = 18;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    try {
      const charge = await checkPendingCharge(reference);
      if (charge.status === 'success') return 'success';
      if (charge.status === 'failed') return 'failed';
    } catch (err) {
      logger.warn({ err }, 'Charge poll attempt failed');
    }
  }
  return 'timeout';
}

async function executeTransfer(
  pending: PendingTransfer,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const db = getDb();

  const bankCode = bankCodes[pending.network];
  if (!bankCode) {
    throw new Error(`${networkLabel(pending.network)} bank code not resolved. Cannot process transfer.`);
  }

  let recipientCode = pending.recipientCode;
  if (!recipientCode) {
    const recipient = await createPaystackRecipient(
      pending.contactNickname,
      pending.phone,
      bankCode
    );
    recipientCode = recipient.recipient_code;
    if (pending.contactId !== null) {
      updateRecipientCode(pending.contactId, recipientCode);
    }
  }

  const transfer = await initiateTransfer(
    recipientCode,
    pending.amountPesewas,
    `Easy-Send to ${pending.contactNickname}`,
    pending.reference
  );

  db.prepare(
    `UPDATE transactions SET status = ?, paystack_transfer_code = ? WHERE paystack_reference = ?`
  ).run(transfer.status, transfer.transfer_code, pending.reference);

  const statusLabel = transfer.status === 'success' ? 'sent' : 'processing';
  await sendReply(
    `Transfer ${statusLabel}!\n\n` +
    `To: ${pending.contactNickname}\n` +
    `Amount: ${formatGHS(pending.amountPesewas)}\n` +
    `Status: ${transfer.status}\n` +
    `Ref: ${pending.reference}`
  );

  const newBalance = await getGHSBalance();
  if (newBalance < toPesewas(config.lowBalanceAlertGHS)) {
    await sendReply(`Low balance alert: ${formatGHS(newBalance)} remaining.`);
  }
}

export async function handleBalance(sendReply: (text: string) => Promise<void>): Promise<void> {
  try {
    const balancePesewas = await getGHSBalance();
    await sendReply(`Paystack Balance: *${formatGHS(balancePesewas)}*`);
  } catch (err: any) {
    logger.error(err, 'Balance check failed');
    await sendReply(`Could not fetch balance: ${err.message}`);
  }
}

export async function handleHistory(sendReply: (text: string) => Promise<void>): Promise<void> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT t.amount_pesewas, t.status, t.created_at, c.nickname
       FROM transactions t
       LEFT JOIN contacts c ON c.id = t.contact_id
       ORDER BY t.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{ amount_pesewas: number; status: string; created_at: string; nickname: string | null }>;

  if (rows.length === 0) {
    await sendReply('No transactions yet.');
    return;
  }

  const lines = rows.map(
    (r, i) => `${i + 1}. ${formatGHS(r.amount_pesewas)} to ${r.nickname ?? 'ad-hoc'} — ${r.status} (${r.created_at})`
  );
  await sendReply(`*Last ${rows.length} Transactions*\n\n${lines.join('\n')}`);
}

export async function handleContacts(sendReply: (text: string) => Promise<void>): Promise<void> {
  const contacts = getAllContacts();
  if (contacts.length === 0) {
    await sendReply('No contacts. Add one with: *add contact Name 024XXXXXXX*');
    return;
  }

  const lines = contacts.map(c => `- ${c.nickname}: ${toLocal(c.phone)}`);
  await sendReply(`*Contacts*\n\n${lines.join('\n')}`);
}

export async function handleAddContact(
  cmd: ParsedCommand,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  if (!cmd.contactName || !cmd.contactPhone) {
    await sendReply('Usage: *add contact Name 024XXXXXXX*');
    return;
  }

  const existing = findContactByNickname(cmd.contactName);
  if (existing) {
    await sendReply(`Contact "${cmd.contactName}" already exists (${toLocal(existing.phone)}).`);
    return;
  }

  const contact = addContact(cmd.contactName, cmd.contactPhone);
  await sendReply(`Contact added: ${contact.nickname} (${toLocal(contact.phone)})`);
}

export async function handleHelp(sendReply: (text: string) => Promise<void>): Promise<void> {
  await sendReply(
    `*Easy-Send Commands*\n\n` +
    `*send 50 to Kojo* — Send to a saved contact\n` +
    `*send fifty cedis paul* — Words work too\n` +
    `*send 30 to 0241234567* — Send to any MoMo number\n` +
    `*bal* — Check Paystack balance\n` +
    `*history* — Recent transactions\n` +
    `*contacts* — List contacts\n` +
    `*add contact Name 024XXX* — Add contact\n` +
    `*help* — Show this message`
  );
}
