import { ParsedCommand } from '../parser/types';
import { resolveRecipient } from '../contacts/resolver';
import { findContactByNickname, getAllContacts, addContact, updateRecipientCode } from '../contacts/store';
import { validateAmount } from '../payment/validator';
import { toPesewas, formatGHS } from '../utils/money';
import { toLocal, toInternational } from '../utils/phone';
import {
  generateReference,
  getGHSBalance,
  createRecipient as createPaystackRecipient,
  initiateTransfer,
  resolveTelecelCode,
  chargeMobileMoney,
  submitChargeOTP,
  checkPendingCharge,
} from '../payment/paystack';
import {
  PendingTransfer,
  setAwaitingConfirmation,
  setAwaitingVoucher,
  getPendingTransfer,
  getPendingCharge,
  clearPending,
  isAwaitingConfirmation,
} from './state';
import { getDb } from '../db/client';
import { logger } from '../utils/logger';
import { config } from '../config';

// Cache the Telecel bank code after resolving at startup
let telecelBankCode: string | null = null;

export async function initPaymentProvider(): Promise<void> {
  telecelBankCode = await resolveTelecelCode();
  if (!telecelBankCode) {
    logger.warn('Telecel bank code not found — transfers will fail until resolved');
  }
}

export async function handleSend(
  cmd: ParsedCommand,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  if (!cmd.amount || !cmd.recipient) {
    await sendReply('Could not parse amount or recipient. Try: *send 50 to Kojo*');
    return;
  }

  // Resolve contact
  const resolved = resolveRecipient(cmd.recipient);
  if (!resolved) {
    await sendReply(
      `Contact "${cmd.recipient}" not found.\n\nAdd them with:\n*add contact ${cmd.recipient} 024XXXXXXX*`
    );
    return;
  }

  // Validate amount
  const validation = validateAmount(cmd.amount);
  if (!validation.ok) {
    await sendReply(validation.error!);
    return;
  }

  const amountPesewas = toPesewas(cmd.amount);
  const reference = generateReference();

  // Store pending transaction in DB before confirmation
  const db = getDb();
  db.prepare(
    `INSERT INTO transactions (contact_id, amount_pesewas, status, paystack_reference, reason)
     VALUES (?, ?, 'pending', ?, ?)`
  ).run(resolved.contact.id, amountPesewas, reference, `Send to ${resolved.displayName}`);

  // Set awaiting confirmation
  setAwaitingConfirmation(
    {
      contactId: resolved.contact.id,
      contactNickname: resolved.displayName,
      phone: resolved.contact.phone,
      recipientCode: resolved.contact.recipient_code,
      amountGHS: cmd.amount,
      amountPesewas,
      reference,
    },
    async () => {
      await sendReply('Transfer cancelled — confirmation timed out.');
      db.prepare("UPDATE transactions SET status = 'cancelled' WHERE paystack_reference = ?").run(reference);
    }
  );

  await sendReply(
    `*Confirm Transfer*\n\n` +
    `To: ${resolved.displayName} (${toLocal(resolved.contact.phone)})\n` +
    `Amount: ${formatGHS(amountPesewas)}\n\n` +
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

  // Execute the transfer
  try {
    if (!telecelBankCode) {
      throw new Error('Telecel bank code not resolved. Cannot process transfer.');
    }

    // Check balance — auto-fund if insufficient
    const balancePesewas = await getGHSBalance();
    if (balancePesewas < pending.amountPesewas) {
      await startAutoFund(pending, balancePesewas, sendReply);
      return;
    }

    // Balance sufficient — transfer directly
    await executeTransfer(pending, sendReply);
  } catch (err: any) {
    logger.error(err, 'Transfer failed');
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(pending.reference);
    await sendReply(`Transfer failed: ${err.message}`);
  }
}

/** Initiate a mobile money charge to fund Paystack balance */
async function startAutoFund(
  pending: PendingTransfer,
  currentBalancePesewas: number,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const deficit = pending.amountPesewas - currentBalancePesewas;

  await sendReply(
    `Insufficient Paystack balance (${formatGHS(currentBalancePesewas)}).\n` +
    `Charging ${formatGHS(deficit)} from your Telecel wallet...`
  );

  const chargeRef = generateReference();
  const phone = toInternational(config.ownerPhone);
  const db = getDb();

  // Store the charge reference on the transaction
  db.prepare(
    `UPDATE transactions SET charge_reference = ? WHERE paystack_reference = ?`
  ).run(chargeRef, pending.reference);

  try {
    const charge = await chargeMobileMoney(
      deficit,
      phone,
      config.ownerEmail,
      chargeRef
    );

    if (charge.status === 'success') {
      // Charge completed immediately (unlikely for Vodafone but handle it)
      await sendReply('Wallet charged successfully.');
      await executeTransfer(pending, sendReply);
      return;
    }

    if (charge.status === 'send_otp') {
      // Vodafone flow: user needs to generate a voucher
      const instruction = charge.display_text ||
        'Dial *110# on your phone → My Wallet → Generate Voucher. Send the voucher code here.';

      setAwaitingVoucher(
        { chargeReference: chargeRef, transfer: pending },
        async () => {
          await sendReply('Voucher timed out — transfer cancelled.');
          db.prepare("UPDATE transactions SET status = 'cancelled' WHERE paystack_reference = ?").run(pending.reference);
        }
      );

      await sendReply(instruction);
      return;
    }

    if (charge.status === 'pay_offline') {
      // MTN-style flow: user approves on phone, we poll
      const instruction = charge.display_text ||
        'Approve the payment prompt on your phone.';

      setAwaitingVoucher(
        { chargeReference: chargeRef, transfer: pending },
        async () => {
          await sendReply('Payment approval timed out — transfer cancelled.');
          db.prepare("UPDATE transactions SET status = 'cancelled' WHERE paystack_reference = ?").run(pending.reference);
        }
      );

      await sendReply(instruction + '\n\nSend *done* once you have approved.');
      return;
    }

    // Unexpected status
    throw new Error(`Unexpected charge status: ${charge.status}`);
  } catch (err: any) {
    logger.error(err, 'Auto-fund charge failed');
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(pending.reference);
    await sendReply(`Could not charge wallet: ${err.message}`);
  }
}

/** Handle voucher/OTP submission or "done" for pay_offline */
export async function handleVoucher(
  text: string,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const pendingCharge = getPendingCharge();
  if (!pendingCharge) {
    await sendReply('No pending charge to complete.');
    return;
  }

  const { chargeReference, transfer } = pendingCharge;
  clearPending();
  const db = getDb();

  try {
    await sendReply('Processing...');

    const otp = text.trim();
    let charge;

    if (/^\d+$/.test(otp)) {
      // Numeric input → submit as OTP/voucher
      charge = await submitChargeOTP(chargeReference, otp);
    } else {
      // Non-numeric (e.g. "done") → check pending status
      charge = await checkPendingCharge(chargeReference);
    }

    if (charge.status === 'success') {
      await sendReply('Wallet charged successfully.');
      await executeTransfer(transfer, sendReply);
      return;
    }

    if (charge.status === 'pending') {
      // Still pending — poll once more after a short delay
      await new Promise(resolve => setTimeout(resolve, 5000));
      charge = await checkPendingCharge(chargeReference);

      if (charge.status === 'success') {
        await sendReply('Wallet charged successfully.');
        await executeTransfer(transfer, sendReply);
        return;
      }

      db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(transfer.reference);
      await sendReply(`Charge still pending. Please try the transfer again.\nRef: ${chargeReference}`);
      return;
    }

    // Failed or unexpected
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(transfer.reference);
    await sendReply(`Charge failed (${charge.status}). Transfer cancelled.`);
  } catch (err: any) {
    logger.error(err, 'Voucher submission failed');
    db.prepare("UPDATE transactions SET status = 'failed' WHERE paystack_reference = ?").run(transfer.reference);
    await sendReply(`Charge failed: ${err.message}`);
  }
}

/** Execute the actual Paystack transfer (shared by direct and auto-funded paths) */
async function executeTransfer(
  pending: PendingTransfer,
  sendReply: (text: string) => Promise<void>
): Promise<void> {
  const db = getDb();

  if (!telecelBankCode) {
    throw new Error('Telecel bank code not resolved. Cannot process transfer.');
  }

  // Create Paystack recipient if not yet created
  let recipientCode = pending.recipientCode;
  if (!recipientCode) {
    await sendReply('Setting up recipient...');
    const recipient = await createPaystackRecipient(
      pending.contactNickname,
      pending.phone,
      telecelBankCode
    );
    recipientCode = recipient.recipient_code;
    updateRecipientCode(pending.contactId, recipientCode);
  }

  // Initiate transfer
  const transfer = await initiateTransfer(
    recipientCode,
    pending.amountPesewas,
    `Easy-Send to ${pending.contactNickname}`,
    pending.reference
  );

  // Update transaction record
  db.prepare(
    `UPDATE transactions SET status = ?, paystack_transfer_code = ? WHERE paystack_reference = ?`
  ).run(transfer.status, transfer.transfer_code, pending.reference);

  const statusEmoji = transfer.status === 'success' ? 'sent' : 'processing';
  await sendReply(
    `Transfer ${statusEmoji}!\n\n` +
    `To: ${pending.contactNickname}\n` +
    `Amount: ${formatGHS(pending.amountPesewas)}\n` +
    `Status: ${transfer.status}\n` +
    `Ref: ${pending.reference}`
  );

  // Low balance alert
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
       JOIN contacts c ON c.id = t.contact_id
       ORDER BY t.created_at DESC
       LIMIT 10`
    )
    .all() as Array<{ amount_pesewas: number; status: string; created_at: string; nickname: string }>;

  if (rows.length === 0) {
    await sendReply('No transactions yet.');
    return;
  }

  const lines = rows.map(
    (r, i) => `${i + 1}. ${formatGHS(r.amount_pesewas)} to ${r.nickname} — ${r.status} (${r.created_at})`
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
    `*send 50 to Kojo* — Send money\n` +
    `*send 20 cedis to Ama* — Send with currency\n` +
    `*bal* — Check Paystack balance\n` +
    `*history* — Recent transactions\n` +
    `*contacts* — List contacts\n` +
    `*add contact Name 024XXX* — Add contact\n` +
    `*help* — Show this message`
  );
}
