import express from "express";
import { openDatabase, saveLead, CONSENT_VERSION, CONSENT_TEXT, STATUSES, audit, rateLimit, maintainDatabase, transaction } from "./database.js";
import {
  hashPassword, verifyPassword, replacePassword, createSession, findSession, validPassword,
  hasRecoveryCode, issueRecoveryCode, verifyRecoveryCode, COOKIE, cookieOptions,
} from './auth.js';
import { createNotifier } from "./notifications.js";
import { installNews } from "./news.js";
import { createReviewsUpdater } from './reviews.js';
import { installSitePages } from './site-pages.js';

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createApplication(config, { fetchImpl = fetch } = {}) {
  const db = openDatabase(config.dbPath);
  const app = express();
  const notifier = createNotifier(db, config, fetchImpl);
  const reviews = createReviewsUpdater(config, { fetchImpl });
  let passwordChecks = 0;
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);
  app.use((req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
    if (config.production) res.set("Strict-Transport-Security", "max-age=31536000");
    if (req.path.startsWith("/api/admin") || req.path.startsWith("/admin")) res.set("Cache-Control", "no-store");
    if (req.path.startsWith("/admin")) {
      res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    }
    next();
  });
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "json_required" });
      const expectedOrigin = config.siteUrl || `${req.protocol}://${req.get("host")}`;
      if (req.get("origin") && req.get("origin") !== expectedOrigin) return res.status(403).json({ ok: false, error: "origin" });
    }
    next();
  });
  const json = express.json({ limit: "16kb" });
  const imageJson = express.json({ limit: "3mb" });
  app.use((req, res, next) => (req.path === "/api/admin/news/image" ? imageJson : json)(req, res, next));

  function limit(req, res, scope, maximum, milliseconds, identity = req.ip) {
    const result = rateLimit(db, scope, identity, maximum, milliseconds);
    if (result.allowed) return false;
    res.set("Retry-After", String(result.retryAfter)).status(429).json({ ok: false, error: "too_many" });
    return true;
  }
  function auth(req, res, next) {
    const session = findSession(db, req.headers.cookie);
    if (!session) return res.status(401).json({ ok: false, error: "unauthorized" });
    if (!["GET", "HEAD"].includes(req.method) && req.get("x-csrf-token") !== session.csrf_token) {
      return res.status(403).json({ ok: false, error: "csrf" });
    }
    req.adminSession = session;
    next();
  }
  app.get("/api/lead-policy", (_req, res) => res.json({ ok: true, version: CONSENT_VERSION, text: CONSENT_TEXT }));
  app.post("/api/lead", (req, res) => {
    if (limit(req, res, "lead", 5, 10 * 60000)) return;
    if (req.body?.company) return res.json({ ok: true });
    const { name, phone, consent, consentVersion } = req.body || {};
    if (typeof name !== "string" || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
      return res.status(400).json({ ok: false, error: "invalid_name" });
    }
    if (typeof phone !== "string" || phone.length > 40 || !/^\+?[\d\s()\-]+$/.test(phone) ||
        phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 15) {
      return res.status(400).json({ ok: false, error: "invalid_phone" });
    }
    if (consent !== true) return res.status(400).json({ ok: false, error: "no_consent" });
    if (consentVersion !== CONSENT_VERSION) return res.status(400).json({ ok: false, error: "consent_version" });
    saveLead(db, { name: name.trim(), phone: phone.trim() });
    res.status(201).json({ ok: true });
  });

  app.post("/api/admin/login", asyncRoute(async (req, res) => {
    if (limit(req, res, "login-ip", 5, 15 * 60000) || limit(req, res, "login-global", 60, 15 * 60000, "all")) return;
    if (passwordChecks >= 2) return res.status(429).json({ ok: false, error: "too_many" });
    const admin = db.prepare("SELECT * FROM admin WHERE id=1").get();
    if (!admin) return res.status(503).json({ ok: false, error: "setup_required" });
    passwordChecks++;
    try {
      if (!(await verifyPassword(req.body?.password, admin.password_hash))) {
        audit(db, "login_failed");
        return res.status(401).json({ ok: false, error: "invalid_password" });
      }
      const session = createSession(db, admin.version, config.sessionHours);
      if (!session) return res.status(401).json({ ok: false, error: "credentials_changed" });
      res.cookie(COOKIE, session.token, cookieOptions(config));
      res.json({ ok: true, csrfToken: session.csrfToken });
    } finally { passwordChecks--; }
  }));
  const sessionInfo = (req, res) => res.json({ ok: true, csrfToken: req.adminSession.csrf_token,
    expiresAt: req.adminSession.expires_at, notificationsConfigured: notifier.configured,
    retentionDays: config.retentionDays, recoveryConfigured: hasRecoveryCode(db) });
  app.get("/api/admin/session", auth, sessionInfo);
  app.get("/api/admin/check", auth, sessionInfo);
  app.post("/api/admin/logout", auth, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE token_hash=?").run(req.adminSession.token_hash);
    audit(db, "logout");
    res.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
    res.json({ ok: true });
  });
  app.post("/api/admin/password", auth, asyncRoute(async (req, res) => {
    if (limit(req, res, "password", 5, 15 * 60000)) return;
    const { currentPassword, newPassword } = req.body || {};
    if (!validPassword(newPassword)) return res.status(400).json({ ok: false, error: "weak_password" });
    if (currentPassword === newPassword) return res.status(400).json({ ok: false, error: "same_password" });
    if (passwordChecks >= 2) return res.status(429).json({ ok: false, error: "too_many" });
    const admin = db.prepare("SELECT * FROM admin WHERE id=1").get();
    passwordChecks++;
    try {
      if (!(await verifyPassword(currentPassword, admin.password_hash))) return res.status(401).json({ ok: false, error: "invalid_password" });
      const hash = await hashPassword(newPassword);
      if (!replacePassword(db, hash, admin.version)) return res.status(401).json({ ok: false, error: "credentials_changed" });
      res.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
      res.json({ ok: true });
    } finally { passwordChecks--; }
  }));
  app.post('/api/admin/recovery-code', auth, asyncRoute(async (req, res) => {
    if (limit(req, res, 'recovery-code', 5, 15 * 60000)) return;
    if (passwordChecks >= 2) return res.status(429).json({ ok: false, error: 'too_many' });
    const admin = db.prepare('SELECT version,password_hash FROM admin WHERE id=1').get();
    if (admin?.version !== req.adminSession.admin_version) {
      return res.status(401).json({ ok: false, error: 'credentials_changed' });
    }
    passwordChecks += 1;
    try {
      if (!(await verifyPassword(req.body?.currentPassword, admin.password_hash))) {
        return res.status(401).json({ ok: false, error: 'invalid_password' });
      }
      const code = issueRecoveryCode(db, req.headers.cookie, admin.version);
      if (!code) return res.status(401).json({ ok: false, error: 'credentials_changed' });
      res.json({ ok: true, code });
    } finally {
      passwordChecks -= 1;
    }
  }));
  app.post('/api/admin/recover', asyncRoute(async (req, res) => {
    if (limit(req, res, 'recover', 5, 15 * 60000)) return;
    const { code, newPassword } = req.body || {};
    if (!validPassword(newPassword)) return res.status(400).json({ ok: false, error: 'weak_password' });
    const admin = db.prepare('SELECT version FROM admin WHERE id=1').get();
    const verifiedHash = verifyRecoveryCode(db, code);
    if (!admin || !verifiedHash) {
      return res.status(401).json({ ok: false, error: 'invalid_recovery_code' });
    }
    if (passwordChecks >= 2) return res.status(429).json({ ok: false, error: 'too_many' });
    passwordChecks += 1;
    try {
      const hash = await hashPassword(newPassword);
      if (!replacePassword(db, hash, admin.version, verifiedHash)) {
        return res.status(401).json({ ok: false, error: 'invalid_recovery_code' });
      }
      res.clearCookie(COOKIE, { ...cookieOptions(config), maxAge: undefined });
      res.json({ ok: true });
    } finally {
      passwordChecks -= 1;
    }
  }));
  app.get("/api/admin/leads", auth, (req, res) => {
    const status = req.query.status || "all";
    if (status !== "all" && !STATUSES.includes(status)) return res.status(400).json({ ok: false, error: "invalid_status" });
    const page = Math.max(1, Number(req.query.page) || 1);
    if (!Number.isSafeInteger(page) || page > 100000) return res.status(400).json({ ok: false, error: "invalid_page" });
    const total = db.prepare("SELECT count(*) AS total FROM leads WHERE (?='all' OR status=?)").get(status, status).total;
    const items = db.prepare(`SELECT leads.*, notifications.status AS notification_status,
      notifications.attempts AS notification_attempts FROM leads LEFT JOIN notifications ON lead_id=leads.id
      WHERE (?='all' OR leads.status=?) ORDER BY created_at DESC, leads.id DESC LIMIT 25 OFFSET ?`).all(status, status, (page - 1) * 25);
    audit(db, "leads_viewed");
    res.json({ ok: true, items, page, total, pageSize: 25 });
  });
  app.patch("/api/admin/leads/:id", auth, (req, res) => {
    const status = req.body?.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ ok: false, error: "invalid_status" });
    const updated = db.prepare("UPDATE leads SET status=?,updated_at=? WHERE id=?").run(status, Date.now(), req.params.id).changes;
    if (!updated) return res.status(404).json({ ok: false, error: "not_found" });
    audit(db, "lead_status_changed", req.params.id);
    res.json({ ok: true });
  });
  app.delete("/api/admin/leads/:id", auth, (req, res) => {
    const deleted = transaction(db, () => {
      const result = db.prepare("DELETE FROM leads WHERE id=?").run(req.params.id).changes;
      if (result) audit(db, "lead_deleted", req.params.id);
      return result;
    });
    res.status(deleted ? 200 : 404).json({ ok: !!deleted });
  });
  app.post("/api/admin/leads/:id/notify", auth, (req, res) => {
    if (!notifier.configured) return res.status(409).json({ ok: false, error: "notifications_not_configured" });
    if (limit(req, res, "notify", 10, 60000)) return;
    const updated = db.prepare(`UPDATE notifications SET status='pending',attempts=0,last_error=NULL,next_attempt_at=?
      WHERE lead_id=? AND status='failed'`).run(Date.now(), req.params.id).changes;
    if (!updated) return res.status(409).json({ ok: false, error: "notification_not_failed" });
    audit(db, "notification_retried", req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/admin/audit", auth, (_req, res) => {
    res.json({ ok: true, items: db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 50").all() });
  });

  const news = installNews(app, { db, config, auth, asyncRoute, fetchImpl, limit });
  app.get('/api/reviews', (_req,res) => {
    res.set('Cache-Control','public, max-age=300');
    const snapshot=reviews.get();
    res.json({ok:true,...(snapshot || {reviews:[]})});
  });
  app.use("/api", (_req, res) => res.status(404).json({ ok: false, error: "not_found" }));
  installSitePages(app, config);
  app.use(express.static(config.publicDir, { dotfiles: "deny" }));
  app.use((error, _req, res, _next) => {
    const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
    if (status === 500) console.error("request_failed", error.code || error.name);
    res.status(status).json({ ok: false, error: status === 500 ? "server_error" : "invalid_body" });
  });
  maintainDatabase(db, config.retentionDays);
  const maintenance = setInterval(() => {
    try { maintainDatabase(db, config.retentionDays); }
    catch { console.error("database_maintenance_failed"); }
  }, 3600000);
  maintenance.unref();
  return { app, db, notifier, reviews, news, async close() { clearInterval(maintenance); await news.stop(); await reviews.stop(); await notifier.stop(); db.close(); } };
}
