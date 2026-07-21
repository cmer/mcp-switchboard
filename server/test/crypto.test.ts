import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { decrypt, encrypt, hashPassword, loadOrCreateKey, randomToken, verifyPassword } from "../src/lib/crypto.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sb-crypto-"));

beforeAll(() => {
  loadOrCreateKey(tmp);
});

describe("crypto", () => {
  it("round-trips", () => {
    const secret = "hello world 🔐 with unicode";
    expect(decrypt(encrypt(secret))).toBe(secret);
  });

  it("produces different ciphertexts for the same plaintext (fresh IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("throws on tampered ciphertext", () => {
    const blob = Buffer.from(encrypt("secret"), "base64");
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob.toString("base64"))).toThrow();
  });

  it("persists the key across reloads", () => {
    const blob = encrypt("persisted");
    loadOrCreateKey(tmp); // re-read the same key file
    expect(decrypt(blob)).toBe("persisted");
    expect(fs.existsSync(path.join(tmp, "secret.key"))).toBe(true);
  });

  it("hashes and verifies passwords", () => {
    const hash = hashPassword("hunter2");
    expect(verifyPassword("hunter2", hash)).toBe(true);
    expect(verifyPassword("hunter3", hash)).toBe(false);
    expect(verifyPassword("hunter2", "garbage")).toBe(false);
  });

  it("generates prefixed tokens", () => {
    expect(randomToken()).toMatch(/^sk-sb-[A-Za-z0-9_-]{32}$/);
  });
});
