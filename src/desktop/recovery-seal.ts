// SPDX-License-Identifier: EUPL-1.2
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { z } from 'zod';

// The existing owner's scrypt verifier supplies the automatic backup key. Only its public salt leaves the machine;
// the verifier itself is INSIDE the authenticated envelope. Recovery derives the same key from the owner's password.
// Domain separation keeps this key distinct from the sign-in verifier. No extra password needs to be kept on a USB.
const Envelope = z.object({ version: z.literal(1), salt: z.string(), iv: z.string(), tag: z.string(), data: z.string() });
const keyOf = (verifier: Buffer) => createHash('sha256').update('karta-recovery-v1\0').update(verifier).digest();
const AAD = Buffer.from('karta-recovery-v1');

export function sealRecovery(text: string, ownerHash: string): string {
  const [kind, n, r, p, salt, hash] = ownerHash.split('$');
  if (kind !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || salt === undefined || hash === undefined || Buffer.from(hash, 'base64').length !== 32) {
    throw new Error('δεν διαβάζεται ο κωδικός εργοδότη — δεν γράφτηκε αντίγραφο');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(Buffer.from(hash, 'base64')), iv);
  cipher.setAAD(AAD);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return JSON.stringify({ version: 1, salt, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
}

export function openRecovery(text: string, password: string): string {
  try {
    const e = Envelope.parse(JSON.parse(text));
    const salt = Buffer.from(e.salt, 'base64');
    if (salt.length !== 16) throw new Error();
    const verifier = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv('aes-256-gcm', keyOf(verifier), Buffer.from(e.iv, 'base64'));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(e.data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    // JSON/crypto errors must never quote settings, ciphertext, or a password.
    throw new Error('λάθος κωδικός εργοδότη ή αλλοιωμένο αντίγραφο');
  }
}
