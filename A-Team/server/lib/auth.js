import { scrypt, randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { audit, transaction } from "./database.js";

const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export const COOKIE = "antipov_session";
export const hashToken = token => createHash("sha256").update(token).digest("hex");
const RECOVERY_KEY = 'admin_recovery_hash';
const recoveryHash = (db) => db.prepare('SELECT value FROM settings WHERE key=?')
  .get(RECOVERY_KEY)?.value || '';

export function hasRecoveryCode(db) {
  return Boolean(recoveryHash(db));
}

export function issueRecoveryCode(db, cookieHeader, expectedVersion) {
  return transaction(db, () => {
    const session = findSession(db, cookieHeader);
    if (!session || session.admin_version !== expectedVersion) return null;
    const code = randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO settings VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(RECOVERY_KEY, hashToken(code));
    audit(db, 'recovery_code_created');
    return code.match(/.{8}/g).join('-');
  });
}

export function verifyRecoveryCode(db, code) {
  if (typeof code !== 'string' || code.length > 80) return null;
  const normalized = code.replace(/[\s-]/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  const stored = recoveryHash(db);
  if (!/^[a-f0-9]{64}$/.test(stored)) return null;
  const candidate = hashToken(normalized);
  return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(stored, 'hex')) ? candidate : null;
}

export function validPassword(password) {
  return typeof password === "string" && [...password].length >= 14 && Buffer.byteLength(password) <= 256;
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error("Password must contain at least 14 characters (at most 256 UTF-8 bytes).");
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64, options);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 256) return false;
  const [scheme, salt, hash] = (encoded || "").split("$");
  if (scheme !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt || "") || !/^[a-f0-9]{128}$/.test(hash || "")) return false;
  const key = await derive(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(hash, "hex"));
}

// Recheck both credentials in the transaction after the password has been hashed.
export function replacePassword(db, passwordHash, expectedVersion = null, expectedRecoveryHash = null) {
  return transaction(db, () => {
    const current = db.prepare("SELECT version FROM admin WHERE id=1").get();
    if (expectedVersion !== null && current?.version !== expectedVersion) return false;
    if (expectedRecoveryHash !== null && recoveryHash(db) !== expectedRecoveryHash) return false;
    db.prepare(`INSERT INTO admin(id,password_hash,version,updated_at) VALUES(1,?,1,?)
      ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,
      version=admin.version+1,updated_at=excluded.updated_at`).run(passwordHash, Date.now());
    db.exec("DELETE FROM sessions");
    db.prepare('DELETE FROM settings WHERE key=?').run(RECOVERY_KEY);
    // Recovery from the server must also release a lock caused by an attacker.
    db.exec("DELETE FROM rate_limits");
    const event = expectedRecoveryHash
      ? 'password_recovered_all_sessions_revoked'
      : 'password_changed_all_sessions_revoked';
    audit(db, current ? event : 'admin_created');
    return true;
  });
}

export function createSession(db, version, hours, now = Date.now()) {
  return transaction(db, () => {
    if (db.prepare("SELECT version FROM admin WHERE id=1").get()?.version !== version) return null;
    const token = randomBytes(32).toString("hex");
    const csrfToken = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES (?,?,?,?)").run(hashToken(token), csrfToken, version, now + hours * 3600000);
    audit(db, "login_success");
    return { token, csrfToken };
  });
}

export function findSession(db, cookieHeader, now = Date.now()) {
  const token = (cookieHeader || "").split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
  return db.prepare(`SELECT sessions.* FROM sessions JOIN admin ON admin.id=1
    AND admin.version=sessions.admin_version WHERE token_hash=? AND expires_at>?`).get(hashToken(token), now) || null;
}

export function cookieOptions(config) {
  return { httpOnly: true, sameSite: "strict", secure: config.production, path: "/", maxAge: config.sessionHours * 3600000 };
}
