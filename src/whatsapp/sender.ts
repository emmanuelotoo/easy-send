import type { WASocket } from '@whiskeysockets/baileys';

let sock: WASocket | null = null;

export function setSock(socket: WASocket): void {
  sock = socket;
}

export async function sendText(jid: string, text: string): Promise<void> {
  if (!sock) throw new Error('WhatsApp socket not initialized');
  await sock.sendMessage(jid, { text });
}
