import crypto from "node:crypto";

const ALG = "aes-256-gcm";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function encryptJson(value: unknown, password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = crypto.scryptSync(password, salt, KEY_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = {
    v: 1,
    alg: ALG,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64")
  };

  return JSON.stringify(payload);
}

export function decryptJson<T>(raw: string, password: string): T {
  const payload = JSON.parse(raw) as {
    v: number;
    alg: string;
    salt: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (payload.v !== 1 || payload.alg !== ALG) {
    throw new Error("unsupported session payload format");
  }

  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.data, "base64");

  const key = crypto.scryptSync(password, salt, KEY_BYTES);
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
