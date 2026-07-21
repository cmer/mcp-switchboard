import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let key: Buffer | null = null;

export function loadOrCreateKey(dataDir: string): void {
  const keyPath = path.join(dataDir, "secret.key");
  if (fs.existsSync(keyPath)) {
    key = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "hex");
    if (key.length !== 32) throw new Error(`Invalid key length in ${keyPath}`);
    return;
  }
  key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("hex") + "\n", { mode: 0o600 });
}

function requireKey(): Buffer {
  if (!key) throw new Error("Encryption key not loaded — call loadOrCreateKey() first");
  return key;
}

/** AES-256-GCM. Output: base64(iv ‖ tag ‖ ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, requireKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, requireKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** scrypt password hash. Output: scrypt$N$base64(salt)$base64(hash) */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const actual = crypto.scryptSync(password, salt, expected.length, { N, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

export function randomToken(prefix = "sk-sb"): string {
  return `${prefix}-${crypto.randomBytes(24).toString("base64url")}`;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
