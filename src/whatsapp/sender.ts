import { WASocket } from '@whiskeysockets/baileys';

export async function sendText(sock: WASocket, jid: string, text: string): Promise<void> {
  await sock.sendMessage(jid, { text });
}
