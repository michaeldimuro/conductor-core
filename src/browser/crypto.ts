import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { ConductorError } from '../shared/errors.js';
import { randomToken, safeEqual } from '../shared/util.js';

const MAGIC = Buffer.from('CBJ1');
const IV_LEN = 12;
const TAG_LEN = 16;

/** Fresh random 256-bit key, base64 (stored only in the secret store). */
export function newKey(): string {
  return randomBytes(32).toString('base64');
}

function keyBytes(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new ConductorError('internal', 'cookie vault key must be 32 bytes');
  return key;
}

/** AES-256-GCM: MAGIC | iv(12) | tag(16) | ciphertext. */
export function encryptJar(plain: string, keyB64: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', keyBytes(keyB64), iv);
  c.setAAD(MAGIC);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), enc]);
}

/** Throws when the file is truncated, tampered with or encrypted under another key. */
export function decryptJar(buf: Buffer, keyB64: string): string {
  const head = MAGIC.length + IV_LEN + TAG_LEN;
  if (buf.length < head || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new ConductorError('validation', 'not a Conductor cookie jar');
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, head);
  const d = createDecipheriv('aes-256-gcm', keyBytes(keyB64), iv);
  d.setAAD(MAGIC);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(head)), d.final()]).toString('utf8');
}

function sign(nonce: string, key: string): string {
  return createHmac('sha256', Buffer.from(key, 'base64')).update(`takeover.v1.${nonce}`).digest('base64url');
}

/** One-time share token: `<random nonce>.<HMAC-SHA256(nonce)>`. Only its SHA-256 is ever stored. */
export function mintShareToken(key: string): string {
  const nonce = randomToken(32);
  return `${nonce}.${sign(nonce, key)}`;
}

/** Constant-time signature check; says nothing about expiry or whether the session exists. */
export function verifyShareToken(token: string, key: string): boolean {
  const m = /^([A-Za-z0-9_-]{20,100})\.([A-Za-z0-9_-]{20,100})$/.exec(token);
  if (!m) return false;
  return safeEqual(sign(m[1]!, key), m[2]!);
}
