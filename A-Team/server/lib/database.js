import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHmac } from "node:crypto";

export const CONSENT_VERSION = "2026-11-02-v2";
export const CONSENT_TEXT = "Я даю согласие на обработку моих персональных данных (имя, телефон) для связи со мной и записи на тренировку в соответствии с Политикой обработки персональных данных.";
export const STATUSES = ["new", "contacted", "booked", "closed"];

export function openDatabase(filename) {
  mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (process.platform !== "win32") chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS admin (
      id INTEGER PRIMARY KEY CHECK(id = 1), password_hash TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf_token TEXT NOT NULL,
      admin_version INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      consent_at INTEGER NOT NULL, consent_version TEXT NOT NULL, consent_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','booked','closed'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS leads_created ON leads(created_at DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
      last_error TEXT, sent_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('manual','instagram')),
      source_id TEXT UNIQUE, published_at INTEGER NOT NULL, display_date TEXT NOT NULL,
      title TEXT NOT NULL, text TEXT NOT NULL, image TEXT NOT NULL DEFAULT '',
      video TEXT NOT NULL DEFAULT '', has_video INTEGER NOT NULL DEFAULT 0 CHECK(has_video IN (0,1)), video_error TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '', hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS news_published ON news_items(hidden,published_at DESC);
    CREATE TABLE IF NOT EXISTS news_uploads (
      filename TEXT PRIMARY KEY, created_at INTEGER NOT NULL
    ) STRICT;
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(news_items)").all().map(column => column.name));
  for (const [name, definition] of [["video", "TEXT NOT NULL DEFAULT ''"], ["has_video", "INTEGER NOT NULL DEFAULT 0 CHECK(has_video IN (0,1))"], ["video_error", "TEXT NOT NULL DEFAULT ''"]]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE news_items ADD COLUMN ${name} ${definition}`);
  }
  db.exec("PRAGMA user_version = 3");
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('rate_salt', ?)").run(randomBytes(32).toString("hex"));
  return db;
}

export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try { const result = fn(); db.exec("COMMIT"); return result; }
  catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function audit(db, action, target = null, now = Date.now()) {
  db.prepare("INSERT INTO audit(at, action, target) VALUES (?, ?, ?)").run(now, action, target);
}

export function rateLimit(db, scope, identity, limit, windowMs, now = Date.now()) {
  const salt = db.prepare("SELECT value FROM settings WHERE key = 'rate_salt'").get().value;
  const key = createHmac("sha256", salt).update(`${scope}:${identity}`).digest("hex");
  const row = db.prepare(`INSERT INTO rate_limits(key, count, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN reset_at <= ? THEN 1 ELSE count + 1 END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING count, reset_at`).get(key, now + windowMs, now, now);
  return { allowed: row.count <= limit, retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

export function saveLead(db, { name, phone }, now = Date.now()) {
  const id = randomUUID();
  transaction(db, () => {
    db.prepare(`INSERT INTO leads(id,name,phone,created_at,updated_at,consent_at,consent_version,consent_text)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, name, phone, now, now, now, CONSENT_VERSION, CONSENT_TEXT);
    db.prepare("INSERT INTO notifications(lead_id,next_attempt_at) VALUES (?,?)").run(id, now);
    audit(db, "lead_created", id, now);
  });
  return id;
}

export function maintainDatabase(db, retentionDays, now = Date.now()) {
  transaction(db, () => {
    const removed = db.prepare("DELETE FROM leads WHERE created_at < ?").run(now - retentionDays * 86400000).changes;
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM rate_limits WHERE reset_at <= ?").run(now);
    db.prepare("DELETE FROM audit WHERE at < ?").run(now - retentionDays * 86400000);
    if (removed) audit(db, "retention_cleanup", String(removed), now);
  });
}
