import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApplication } from "../lib/app.js";
import { loadConfig, ROOT } from "../lib/config.js";
import { CONSENT_VERSION, CONSENT_TEXT, openDatabase, saveLead, maintainDatabase } from "../lib/database.js";
import { hashPassword, replacePassword, createSession, hashToken } from "../lib/auth.js";
import { createBackup } from "../lib/backup.js";
import { DatabaseSync } from "node:sqlite";
import { collectInstagram } from "../instagram-loader/instagram.js";

const PASSWORD = "test-only password phrase 2026";
const NEW_PASSWORD = "another test-only password phrase";
const lead = { name: "Тестовый посетитель", phone: "+7 (900) 123-45-67", consent: true, consentVersion: CONSENT_VERSION };

async function fixture(t, overrides = {}, fetchImpl = async () => { throw new Error("No real outbound requests in tests"); }, beforeCreate = async () => {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "antipov-test-"));
  const config = { ...loadConfig({}), dataDir: directory, dbPath: path.join(directory, "test.sqlite"), ...overrides };
  await beforeCreate(directory);
  const application = createApplication(config, { fetchImpl });
  const server = application.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await application.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith("antipov-test-"));
    await rm(directory, { recursive: true, force: true });
  });
  async function request(route, { method = "GET", body, cookie, csrf, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) h["Content-Type"] = "application/json";
    if (cookie) h.Cookie = cookie;
    if (csrf) h["X-CSRF-Token"] = csrf;
    const response = await fetch(origin + route, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    return { status: response.status, headers: response.headers, data, text };
  }
  async function login(password = PASSWORD) {
    const result = await request("/api/admin/login", { method: "POST", body: { password } });
    return { ...result, cookie: result.headers.get("set-cookie")?.split(";")[0], csrf: result.data?.csrfToken };
  }
  return { ...application, request, login, config, origin };
}
async function initialize(f) { replacePassword(f.db, await hashPassword(PASSWORD)); }

test("no default password, no public database, and old ADMIN_TOKEN cannot authorize", async t => {
  const f = await fixture(t);
  assert.equal((await f.login()).data.error, "setup_required");
  for (const route of ["/api/admin/leads", "/api/admin/audit", "/api/admin/check"]) {
    assert.equal((await f.request(route, { headers: { Authorization: "Bearer old-password" } })).status, 401);
  }
  for (const route of ["/data/club.sqlite", "/club.sqlite", "/.env", "/lib/database.js"]) assert.equal((await f.request(route)).status, 404);
  const admin = await f.request("/admin/");
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get("cache-control"), "no-store");
  assert.match(admin.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("lead is durable before success, with exact consent evidence and a durable notification", async t => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/lead", { method: "POST", body: { ...lead, phone: "bad" } })).status, 400);
  assert.equal((await f.request("/api/lead", { method: "POST", body: { ...lead, consent: false } })).status, 400);
  assert.equal((await f.request("/api/lead", { method: "POST", body: { ...lead, consentVersion: "old" } })).status, 400);
  assert.equal((await f.request("/api/lead", { method: "POST", body: lead })).status, 201);
  const secondConnection = openDatabase(f.config.dbPath);
  try {
    const row = secondConnection.prepare("SELECT * FROM leads").get();
    assert.equal(row.name, lead.name);
    assert.equal(row.phone, lead.phone);
    assert.equal(row.consent_version, CONSENT_VERSION);
    assert.equal(row.consent_text, CONSENT_TEXT);
    assert.ok(row.consent_at > 0);
    assert.equal(secondConnection.prepare("SELECT status FROM notifications").get().status, "pending");
  } finally { secondConnection.close(); }
});

test("Telegram receives only a generic notification and HTTPS admin link", async t => {
  const requests = [];
  const f = await fixture(t, { telegramToken: "fake-token", telegramChat: "fake-chat", siteUrl: "https://club.example" }, async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ ok: true }) };
  });
  await f.request("/api/lead", { method: "POST", body: lead });
  await f.notifier.runOnce();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.reply_markup.inline_keyboard[0][0].url, "https://club.example/admin/");
  const sent = JSON.stringify(requests[0].body);
  assert.ok(!sent.includes(lead.name) && !sent.includes(lead.phone) && !sent.includes("9001234567"));
  assert.ok(!sent.includes(f.db.prepare("SELECT id FROM leads").get().id));
  assert.equal(f.db.prepare("SELECT status FROM notifications").get().status, "sent");
  await f.notifier.runOnce();
  assert.equal(requests.length, 1);
});

test("Telegram failures retain leads, retry, stop after six failures, and can be retried by admin", async t => {
  const f = await fixture(t, { telegramToken: "fake-token", telegramChat: "fake-chat" });
  await initialize(f);
  const result = await f.request("/api/lead", { method: "POST", body: lead });
  assert.equal(result.status, 201);
  for (let i = 0; i < 6; i++) {
    f.db.prepare("UPDATE notifications SET next_attempt_at=0").run();
    await f.notifier.runOnce();
  }
  const row = f.db.prepare("SELECT * FROM notifications").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 6);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM leads").get().n, 1);
  const session = await f.login();
  assert.equal((await f.request(`/api/admin/leads/${row.lead_id}/notify`, { method: "POST", body: {}, ...session })).status, 200);
  assert.equal(f.db.prepare("SELECT status FROM notifications").get().status, "pending");
});

test("admin access uses hashed session cookies, CSRF and same-origin checks", async t => {
  const f = await fixture(t);
  await initialize(f);
  assert.equal((await f.login("wrong password")).status, 401);
  const session = await f.login();
  assert.equal(session.status, 200);
  assert.match(session.headers.get("set-cookie"), /HttpOnly/);
  assert.match(session.headers.get("set-cookie"), /SameSite=Strict/);
  const token = session.cookie.split("=")[1];
  assert.equal(f.db.prepare("SELECT token_hash FROM sessions").get().token_hash, hashToken(token));
  assert.notEqual(f.db.prepare("SELECT password_hash FROM admin").get().password_hash, PASSWORD);
  const id = saveLead(f.db, lead);
  const list = await f.request("/api/admin/leads", session);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal(list.data.items[0].name, lead.name);
  assert.equal((await f.request(`/api/admin/leads/${id}`, { method: "PATCH", cookie: session.cookie, body: { status: "booked" } })).status, 403);
  assert.equal((await f.request(`/api/admin/leads/${id}`, { method: "PATCH", ...session, body: { status: "booked" }, headers: { Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await f.request(`/api/admin/leads/${id}`, { method: "PATCH", ...session, body: { status: "booked" } })).status, 200);
  assert.equal((await f.request("/api/admin/leads?status=booked", session)).data.total, 1);
  assert.equal((await f.request(`/api/admin/leads/${id}`, { method: "DELETE", ...session, body: {} })).status, 200);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications").get().n, 0);
  assert.ok(!JSON.stringify((await f.request("/api/admin/audit", session)).data).includes(lead.phone));
});

test("password rotation revokes every session, rejects the old password, and allows a new login", async t => {
  const f = await fixture(t);
  await initialize(f);
  const first = await f.login();
  const second = await f.login();
  assert.equal((await f.request("/api/admin/password", { method: "POST", ...first, body: { currentPassword: PASSWORD, newPassword: "short" } })).status, 400);
  const changed = await f.request("/api/admin/password", { method: "POST", ...first, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
  assert.equal(changed.status, 200);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
  assert.equal((await f.request("/api/admin/leads", first)).status, 401);
  assert.equal((await f.request("/api/admin/leads", second)).status, 401);
  assert.equal((await f.login()).status, 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
  assert.equal(createSession(f.db, 1, 8), null, "an in-flight old password check cannot issue a new session");
});

test("server-side recovery works on a live database and expires existing sessions", async t => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  const issued = await f.request('/api/admin/recovery-code', {
    method: 'POST', ...session, body: { currentPassword: PASSWORD },
  });
  assert.equal(issued.status, 200);
  const managementDb = openDatabase(f.config.dbPath);
  try { replacePassword(managementDb, await hashPassword(NEW_PASSWORD)); }
  finally { managementDb.close(); }
  assert.equal((await f.request("/api/admin/session", session)).status, 401);
  const reset = await f.request('/api/admin/recover', {
    method: 'POST', body: { code: issued.data.code, newPassword: PASSWORD },
  });
  assert.equal(reset.status, 401);
  assert.equal((await f.login(NEW_PASSWORD)).status, 200);
});

test('browser recovery replaces old codes and consumes the saved code atomically', async (t) => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  const issue = (credentials, currentPassword = PASSWORD) => f.request('/api/admin/recovery-code', {
    method: 'POST', ...credentials, body: { currentPassword },
  });
  const recover = (code, newPassword = NEW_PASSWORD, headers = {}) => f.request('/api/admin/recover', {
    method: 'POST', body: { code, newPassword }, headers,
  });

  assert.equal((await issue({})).status, 401);
  assert.equal((await issue({ cookie: session.cookie })).status, 403);
  assert.equal((await issue(session, 'wrong password')).status, 401);
  const first = await issue(session);
  const second = await issue(session);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('cache-control'), 'no-store');
  const { code } = second.data;
  assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/);
  const sessionInfo = await f.request('/api/admin/session', session);
  assert.equal(sessionInfo.data.recoveryConfigured, true);
  assert.equal(sessionInfo.data.code, undefined);
  const stored = f.db.prepare("SELECT value FROM settings WHERE key='admin_recovery_hash'").get();
  assert.equal(stored.value, hashToken(code.replaceAll('-', '')));

  assert.equal((await recover(first.data.code)).status, 401);
  assert.equal((await recover(code, 'short')).status, 400);
  assert.equal((await recover(code, NEW_PASSWORD, { Origin: 'https://elsewhere.example' })).status, 403);
  const concurrent = await Promise.all([recover(code), recover(code.toUpperCase())]);
  assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 401]);
  assert.equal((await recover(code)).status, 401);
  assert.equal((await f.request('/api/admin/session', session)).status, 401);
  assert.equal((await f.login()).status, 401);
  const newSession = await f.login(NEW_PASSWORD);
  assert.equal(newSession.status, 200);
  assert.equal((await f.request('/api/admin/session', newSession)).data.recoveryConfigured, false);
  const auditLog = await f.request('/api/admin/audit', newSession);
  assert.ok(auditLog.data.items.some(({ action }) => action === 'password_recovered_all_sessions_revoked'));
  assert.ok(!JSON.stringify(auditLog.data).includes(code));
});

test("login throttling survives reconnection and forged forwarded IPs do not bypass it", async t => {
  const f = await fixture(t);
  await initialize(f);
  for (let i = 0; i < 5; i++) {
    assert.equal((await f.request("/api/admin/login", { method: "POST", body: { password: "bad" }, headers: { "X-Forwarded-For": `203.0.113.${i}` } })).status, 401);
  }
  const limited = await f.login();
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  const secondConnection = openDatabase(f.config.dbPath);
  try { assert.ok(secondConnection.prepare("SELECT count(*) AS n FROM rate_limits").get().n > 0); }
  finally { secondConnection.close(); }
});

test("logout revokes the session, expiry is enforced, and production cookies are Secure", async t => {
  const f = await fixture(t, { production: true, siteUrl: "https://club.example" });
  await initialize(f);
  const session = await f.login();
  assert.match(session.headers.get("set-cookie"), /Secure/);
  assert.equal((await f.request("/api/admin/logout", { method: "POST", ...session, body: {} })).status, 200);
  assert.equal((await f.request("/api/admin/session", session)).status, 401);
  const next = await f.login();
  f.db.exec("UPDATE sessions SET expires_at=0");
  assert.equal((await f.request("/api/admin/session", next)).status, 401);
});

test("retention removes expired leads and outbox entries without removing current leads", async t => {
  const f = await fixture(t);
  saveLead(f.db, lead, Date.now() - 100 * 86400000);
  saveLead(f.db, { name: "Недавняя заявка", phone: lead.phone });
  maintainDatabase(f.db, 90);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM leads").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notifications").get().n, 1);
});

test("news mutations require cookie authentication and CSRF after token migration", async t => {
  const f = await fixture(t);
  await initialize(f);
  assert.equal((await f.request("/api/news", { method: "POST", body: { title: "Новость" }, headers: { Authorization: "Bearer old-password" } })).status, 401);
  const session = await f.login();
  const saved = await f.request("/api/news", { method: "POST", ...session, body: { title: "Тестовая новость", text: "Тест" } });
  assert.equal(saved.status, 200);
  assert.equal((await f.request("/api/news")).data.items[0].title, "Тестовая новость");
});

test('the landing form submits to the server and displays the current consent text', async () => {
  const html = await readFile(path.join(ROOT, 'public/index.html'), 'utf8');
  const template = JSON.parse(html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  const source = template.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function('DCLogic', source));
  assert.ok(source.includes(`consentVersion: "${CONSENT_VERSION}"`));
  assert.ok(source.includes('fetch("/api/lead"'));
  assert.ok(!source.includes('Authorization: "Bearer "'));
  assert.ok(template.includes('name="name"') && template.includes('name="phone"') && template.includes('href="/admin/"'));
  const visibleConsent = template.match(/<span>(Я даю согласие[\s\S]*?)<\/span>/)[1].replace(/<[^>]*>/g, '');
  assert.equal(visibleConsent, CONSENT_TEXT);
});

test('search engines receive club information and the seven canonical section pages in plain HTML', async (t) => {
  const siteUrl = 'https://antipov.team';
  const f = await fixture(t, { siteUrl });
  const landing = await f.request('/');
  assert.equal(landing.status, 200);
  const initialHtml = landing.text.split('<script>')[0];
  assert.match(initialHtml, /<title>Клуб единоборств Antipov Team — Набережные Челны<\/title>/);
  assert.match(initialHtml, /<h1>Клуб единоборств Antipov Team — Набережные Челны<\/h1>/);
  assert.match(initialHtml, /<address>Набережные Челны, проспект Сююмбике, 2\/19/);
  const robots = await f.request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.ok(robots.text.includes(`Sitemap: ${siteUrl}/sitemap.xml`));
  const sitemap = await f.request('/sitemap.xml');
  assert.match(sitemap.headers.get('content-type'), /xml/);
  const urls = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((entry) => entry[1]);
  assert.equal(urls.length, 8);
  assert.equal(urls[0], `${siteUrl}/`);
  for (const canonical of urls.slice(1)) {
    const { pathname } = new URL(canonical);
    assert.ok(initialHtml.includes(`href="${pathname}"`));
    const page = await f.request(pathname);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<link rel="canonical" href="${canonical}">`));
    assert.match(page.text, /<h1>[^<]+в Набережных Челнах<\/h1>/);
    assert.match(page.text, /<tbody><tr><td>/);
    assert.match(page.text, /href="\/#contacts">Записаться на тренировку/);
  }
  assert.equal((await f.request('/sekcii/mma')).headers.get('location'), '/sekcii/mma/');
  assert.equal((await f.request('/sekcii/unknown/')).status, 404);
});

test("developer contact replaces the prompt with a mail link", async () => {
  const html = await readFile(path.join(ROOT, "public/index.html"), "utf8");
  const template = JSON.parse(html.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/)[1]);
  assert.match(template, /<sc-if value="{{ developerPromptVisible }}"[^>]*><button class="developer-contact"/);
  assert.match(template, /<sc-if value="{{ developerEmailVisible }}"[^>]*><a class="developer-email" href="mailto:rushan\.shakirzianov@gmail\.com\?subject=/);
});

test("configuration rejects production without HTTPS and publicly exposed data directories", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }), /SITE_URL/);
  assert.throws(() => loadConfig({ DATA_DIR: "public/data" }), /outside public/);
  assert.throws(() => loadConfig({ LEAD_RETENTION_DAYS: "0" }), /LEAD_RETENTION_DAYS/);
  assert.throws(() => loadConfig({ IG_NEWS_FEED_URL: "http://unsafe.example/news" }), /HTTPS/);
  assert.throws(() => loadConfig({ IG_NEWS_FEED_URL: "https://loader.example/news" }), /TOKEN/);
});

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lLkAAAAASUVORK5CYII=";
const image = { type: "image/png", data: PNG };
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const imported = (id = "101") => ({ id, caption: `Турнир ${id}\nПобеда команды. #НОВОСТИ`, timestamp: "2026-11-01T14:00:00Z", link: `https://www.instagram.com/p/test${id}/`, image });

test("manual news can be created with a local image, edited and deleted in the admin API", async t => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  assert.equal((await f.request("/api/admin/news")).status, 401);
  assert.equal((await f.request("/api/admin/news/image", { method: "POST", cookie: session.cookie, body: image })).status, 403);
  const upload = await f.request("/api/admin/news/image", { method: "POST", ...session, body: image });
  assert.equal(upload.status, 200);
  assert.match(upload.data.image, /^\/media\/news\/[a-f0-9]{64}\.png$/);
  assert.equal((await f.request(upload.data.image)).status, 404, "unpublished uploads are private");
  const created = await f.request("/api/admin/news", { method: "POST", ...session,
    body: { title: "Ручная новость", text: "Первая строка\nВторая строка", date: "2026-11-02", image: upload.data.image } });
  assert.equal(created.status, 200);
  const id = created.data.item.id;
  const cover = await f.request(upload.data.image);
  assert.equal(cover.status, 200);
  assert.match(cover.headers.get("content-type"), /^image\/png/);
  assert.equal((await f.request("/api/news")).data.items[0].image, upload.data.image);
  assert.equal((await f.request(`/api/admin/news/${id}`, { method: "PATCH", ...session,
    body: { title: "Исправленная новость", text: "Новый текст", date: "2026-11-02", image: upload.data.image } })).status, 200);
  assert.equal((await f.request("/api/news")).data.items[0].title, "Исправленная новость");
  assert.equal((await f.request(`/api/admin/news/${id}`, { method: "DELETE", ...session, body: {} })).status, 200);
  assert.equal((await f.request("/api/news")).data.items.length, 0);
  assert.equal((await f.request(upload.data.image)).status, 404);
});

test("news upload rejects scripts disguised as images, oversized files and external image links", async t => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  assert.equal((await f.request("/api/admin/news/image", { method: "POST", ...session, body: { type: "image/png", data: svg } })).status, 400);
  assert.equal((await f.request("/api/admin/news/image", { method: "POST", ...session, body: { type: "image/png", data: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") } })).status, 400);
  assert.equal((await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Новость", image: "https://external.example/picture.jpg" } })).status, 400);
  assert.equal((await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Новость", date: "2026-02-31" } })).status, 400);
});

test("Instagram import is explicit, persistent, deduplicated and keeps removed posts hidden", async t => {
  let calls = 0;
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsFeedToken: "test-token", instagramHashtag: "новости" }, async (url, options) => {
    calls++;
    assert.equal(url, "https://loader.example/news");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [imported()] });
  });
  await initialize(f);
  const session = await f.login();
  await f.request("/api/news");
  assert.equal(calls, 0, "public visitors never trigger Meta/loader requests");
  assert.equal((await f.request("/api/admin/news/import", { method: "POST", cookie: session.cookie, body: {} })).status, 403);
  const first = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(first.status, 200);
  assert.equal(first.data.added, 1);
  assert.equal((await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} })).status, 429);
  f.db.exec("DELETE FROM rate_limits");
  const again = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(again.data.updated, 1);
  let items = (await f.request("/api/news")).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].source, "Instagram");
  assert.ok(!items[0].text.includes("#НОВОСТИ"));
  assert.match(items[0].image, /^\/media\/news\//);
  const id = encodeURIComponent(items[0].id);
  await f.request(`/api/admin/news/${id}`, { method: "DELETE", ...session, body: {} });
  f.db.exec("DELETE FROM rate_limits");
  const hidden = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(hidden.data.skipped, 1);
  assert.equal((await f.request("/api/news")).data.items.length, 0);
  assert.equal((await f.request("/api/admin/news?filter=hidden", session)).data.total, 1);
  const second = createApplication(f.config, { fetchImpl: async () => { throw new Error("unexpected network"); } });
  try { assert.equal(second.db.prepare("SELECT hidden FROM news_items").get().hidden, 1); }
  finally { await second.close(); }
  assert.equal((await f.request(`/api/admin/news/${id}`, { method: "PATCH", ...session, body: { hidden: false } })).status, 200);
  items = (await f.request("/api/news")).data.items;
  assert.equal(items.length, 1);
});

test("failed or malformed Instagram imports leave published news unchanged", async t => {
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", instagramHashtag: "новости" }, async () =>
    jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [imported("201"), { ...imported("202"), caption: "#новостиспорта" }] }));
  await initialize(f);
  const session = await f.login();
  await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Сохранённая новость" } });
  const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(result.status, 502);
  assert.equal((await f.request("/api/news")).data.items[0].title, "Сохранённая новость");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM news_items").get().n, 1, "no partially imported news");
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='news_last_import'").get(), undefined);
});

test("direct Instagram import paginates and filters before selecting three latest tagged posts", async t => {
  let pageCalls = 0;
  let images = 0;
  const f = await fixture(t, { instagramUser: "12345", instagramToken: "fake-meta-token", instagramHashtag: "новости", instagramVersion: "v25.0", instagramLogin: "facebook" }, async (url, options) => {
    url = new URL(url);
    if (url.hostname === "graph.facebook.com") {
      pageCalls++;
      assert.equal(options.headers.Authorization, "Bearer fake-meta-token");
      assert.equal(url.searchParams.get("access_token"), null);
      if (!url.searchParams.has("after")) return jsonResponse({ data: [{ id: "1", caption: "Другая публикация #новостиспорта" }], paging: { next: "ignored-url", cursors: { after: "cursor-2" } } });
      return jsonResponse({ data: Array.from({ length: 7 }, (_, i) => ({ id: String(100 + i), caption: `Событие ${i}\nОписание #НоВоСтИ`, timestamp: `2026-10-${String(10 + i).padStart(2, "0")}T12:00:00Z`, media_type: i === 0 ? "VIDEO" : "IMAGE", media_url: "https://scontent.cdninstagram.com/photo.png", thumbnail_url: "https://scontent.cdninstagram.com/cover.png", permalink: `https://www.instagram.com/p/test${i}/` })) });
    }
    assert.equal(url.hostname, "scontent.cdninstagram.com");
    images++;
    return new Response(Buffer.from(PNG, "base64"), { headers: { "Content-Type": "image/png" } });
  });
  await initialize(f);
  const session = await f.login();
  const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.data.added, 3);
  assert.equal(pageCalls, 2);
  assert.equal(images, 3);
  const items = (await f.request("/api/news")).data.items;
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Событие 6");
  assert.equal(items[2].title, "Событие 4");
});

test("legacy manual news migrate once without duplication and the public feed shows three newest items", async t => {
  const legacy = Array.from({ length: 8 }, (_, i) => ({ id: `old-${i}`, title: `Новость ${i}`, date: `2026-10-${10 + i}`, text: "Старый текст" }));
  const f = await fixture(t, {}, undefined, async directory => writeFile(path.join(directory, "news.json"), JSON.stringify(legacy)));
  const items = (await f.request("/api/news")).data.items;
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Новость 7");
  assert.equal(items[2].title, "Новость 5");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM news_items").get().n, 8);
  const second = createApplication(f.config);
  try { assert.equal(second.db.prepare("SELECT count(*) AS n FROM news_items").get().n, 8); }
  finally { await second.close(); }
});

test("existing Instagram captions are split at the first sentence and truncated records are refreshed", async t => {
  const headline = "На этих выходных прошли соревнования в г. Казани, где спортсмены из нескольких регионов показали хорошие результаты и завоевали новые медали.";
  const text = `Результаты турнира:\n\n${"Поздравляем участников с победой! ".repeat(65).trim()}`;
  assert.ok(headline.length > 120 && text.length > 2000);
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news" }, async () =>
    jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [{ ...imported("201"), caption: `${headline} ${text} #новости` }] }), async directory => {
    const db = openDatabase(path.join(directory, "test.sqlite"));
    const add = db.prepare(`INSERT INTO news_items(id,source,source_id,published_at,display_date,title,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`);
    const now = Date.now();
    add.run("instagram:201", "instagram", "201", now, "2026-11-01", headline.slice(0, 120), text.slice(0, 2000), now, now);
    add.run("instagram:202", "instagram", "202", now - 1000, "2026-10-31", "Г. Москва. Результаты уже известны.", "Вторая строка", now, now);
    add.run("manual", "manual", null, now - 2000, "2026-10-30", "Ручная новость. Заголовок целиком.", "Ручной текст", now, now);
    db.prepare("INSERT INTO settings VALUES ('news_last_import',?)").run(String(now - 7200000));
    db.prepare("INSERT INTO settings VALUES ('news_last_attempt',?)").run(String(now - 7200000));
    db.close();
  });
  const readNews = async id => (await f.request("/api/news")).data.items.find(item => item.id === id);
  const archive = await readNews("instagram:202");
  assert.equal(archive.title, "Г. Москва.");
  assert.equal(archive.text, "Результаты уже известны.\nВторая строка");
  assert.equal((await readNews("manual")).title, "Ручная новость. Заголовок целиком.");
  const refreshed = await f.news.refresh({ automatic: true });
  assert.equal(refreshed.updated, 1);
  const restored = await readNews("instagram:201");
  assert.equal(restored.title, headline);
  assert.equal(restored.text, text);
  assert.equal(await f.news.refresh({ automatic: true }), null);
});

test("Instagram import reports missing setup instead of fake success", async t => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  assert.equal((await f.request("/api/admin/news", session)).data.importConfigured, false);
  assert.equal((await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} })).data.error, "instagram_not_configured");
});

test("automatic Instagram updates run daily, share in-flight work and survive restart", async t => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsFeedToken: "source-only-secret", instagramUsername: "antipov__team" }, async () => {
    calls++;
    await gate;
    return jsonResponse({ schemaVersion: 1, hashtag: "новости", accountUsername: "antipov__team", scanned: 20, items: [imported()] });
  });
  await initialize(f);
  const session = await f.login();
  assert.equal((await f.request("/api/admin/news", session)).data.autoUpdate, true);
  await f.request("/api/news");
  assert.equal(calls, 0, "a visitor cannot start an import");
  const first = f.news.refresh({ automatic: true });
  assert.equal(f.news.refresh({ automatic: true }), first);
  await assert.rejects(f.news.refresh(), /import_busy/);
  release();
  assert.equal((await first).scanned, 20);
  assert.equal(calls, 1);
  assert.equal(await f.news.refresh({ automatic: true }), null);
  const info = (await f.request("/api/admin/news", session)).data;
  assert.equal(info.account, "antipov__team");
  assert.ok(info.nextImport >= info.lastImport + 86400000);
  assert.equal(info.lastError, "");
  const second = createApplication(f.config, { fetchImpl: async () => { throw new Error("not due after restart"); } });
  try { assert.equal(await second.news.refresh({ automatic: true }), null); }
  finally { await second.close(); }
  f.db.prepare("UPDATE settings SET value=? WHERE key IN ('news_last_import','news_last_attempt')").run(String(Date.now() - 90000000));
  assert.equal((await f.news.refresh({ automatic: true })).updated, 1);
  assert.equal(calls, 2);
  assert.equal((await f.request("/api/news")).data.items.length, 1);
});

test("failed automatic imports retain news and persist one-hour retry backoff", async t => {
  let calls = 0;
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsFeedToken: "never-return-this-secret" }, async () => {
    calls++;
    throw new Error("network failure including never-return-this-secret");
  });
  await initialize(f);
  const session = await f.login();
  await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Новости клуба сохранены" } });
  await assert.rejects(f.news.refresh({ automatic: true }), /^Error: instagram_unavailable$/);
  assert.equal(await f.news.refresh({ automatic: true }), null);
  const info = (await f.request("/api/admin/news", session)).data;
  assert.equal(info.lastError, "instagram_unavailable");
  assert.ok(info.nextImport >= info.lastAttempt + 3600000);
  assert.ok(!JSON.stringify(info).includes("never-return-this-secret"));
  const second = createApplication(f.config, { fetchImpl: async () => { calls++; throw new Error("should not retry"); } });
  try { assert.equal(await second.news.refresh({ automatic: true }), null); }
  finally { await second.close(); }
  assert.equal(calls, 1);
  assert.equal((await f.request("/api/news")).data.items[0].title, "Новости клуба сохранены");
});

test("disabled or unconfigured news scheduler never starts an outbound request", async t => {
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsAutoUpdate: false });
  f.news.start();
  assert.equal(await f.news.refresh({ automatic: true }), null);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='news_last_attempt'").get(), undefined);
  const second = await fixture(t);
  second.news.start();
  assert.equal(second.news.configured, false);
  await assert.rejects(second.news.refresh(), /instagram_not_configured/);
});

test("the configured Instagram account is checked before any post is published", async t => {
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", instagramUsername: "antipov__team" }, async () =>
    jsonResponse({ schemaVersion: 1, hashtag: "новости", accountUsername: "another_club", items: [imported()] }));
  await initialize(f);
  const session = await f.login();
  const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(result.status, 502);
  assert.equal(result.data.error, "instagram_account_mismatch");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM news_items").get().n, 0);
});

test("official Instagram API validates the account and does not send tokens in URLs", async () => {
  const calls = [];
  const config = { instagramUser: "12345", instagramToken: "private-instagram-token", instagramVersion: "v25.0", instagramLogin: "instagram", instagramHashtag: "новости", instagramUsername: "antipov__team" };
  const result = await collectInstagram(config, async (value, options) => {
    const url = new URL(value);
    calls.push(url.href);
    assert.equal(url.hostname, "graph.instagram.com");
    assert.equal(options.headers.Authorization, "Bearer private-instagram-token");
    assert.equal(options.redirect, "error");
    assert.ok(!url.href.includes("private-instagram-token"));
    return url.pathname.endsWith("/media") ? jsonResponse({ data: [] }) : jsonResponse({ id: "12345", username: "ANTIPOV__TEAM" });
  });
  assert.equal(calls.length, 2);
  assert.equal(result.accountUsername, "antipov__team");
  assert.equal(result.scanned, 0);
  assert.deepEqual(result.items, []);
  await assert.rejects(collectInstagram(config, async () => jsonResponse({ id: "12345", username: "another_club" })), /instagram_account_mismatch/);
  await assert.rejects(collectInstagram(config, async () => new Response("{}", { status: 401 })), /instagram_auth/);
  await assert.rejects(collectInstagram(config, async () => new Response(JSON.stringify({ error: { code: 190, message: "private-token-details" } }), { status: 400 })), /^Error: instagram_auth$/);
});

test("loader authentication failures are actionable without exposing its response", async t => {
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news" }, async () =>
    new Response(JSON.stringify({ ok: false, error: "instagram_auth", privateDetails: "do-not-expose" }), { status: 502 }));
  await initialize(f);
  const session = await f.login();
  const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(result.status, 502);
  assert.equal(result.data.error, "instagram_auth");
  assert.ok(!result.text.includes("do-not-expose"));
  assert.equal((await f.request("/api/admin/news", session)).data.lastError, "instagram_auth");
});

test("background Instagram imports return immediately and publish after loader polling completes", async t => {
  let calls = 0;
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsAsyncImport: true }, async (_url, options) => {
    calls++;
    if (calls === 1) {
      assert.equal(options.headers["X-News-Refresh"], "1");
      return new Response(JSON.stringify({ ok: true, pending: true }), { status: 202, headers: { "Retry-After": "1" } });
    }
    assert.equal(options.headers["X-News-Refresh"], undefined, "polling must not restart the source job");
    return jsonResponse({ schemaVersion: 1, hashtag: "новости", generatedAt: "2026-11-03T10:00:00Z", scanned: 100, scanLimit: 100, items: [imported()] });
  });
  await initialize(f);
  const session = await f.login();
  const response = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(response.status, 202);
  assert.equal(response.data.pending, true);
  assert.equal((await f.request("/api/admin/news", session)).data.importing, true);
  assert.equal((await f.request("/api/news")).data.items.length, 0);
  const result = await f.news.refresh({ automatic: true });
  assert.equal(result.added, 1);
  assert.equal(calls, 2);
  const status = (await f.request("/api/admin/news", session)).data;
  assert.equal(status.importing, false);
  assert.equal(status.lastResult.scanLimit, 100);
  assert.equal(status.sourceUpdated, Date.parse("2026-11-03T10:00:00Z"));
  assert.equal((await f.request("/api/news")).data.items.length, 1);
});

test("unencrypted Instagram feed URLs are restricted to local development", () => {
  const common = { IG_NEWS_FEED_TOKEN: "test-only-common-secret-of-32-characters" };
  assert.equal(loadConfig({ ...common, IG_NEWS_FEED_URL: "http://127.0.0.1:3100/news" }).newsFeedUrl, "http://127.0.0.1:3100/news");
  assert.throws(() => loadConfig({ ...common, IG_NEWS_FEED_URL: "http://loader.example/news" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...common, NODE_ENV: "production", SITE_URL: "https://club.example", IG_NEWS_FEED_URL: "http://127.0.0.1:3100/news" }), /HTTPS/);
  assert.throws(() => loadConfig({ ...common, IG_NEWS_FEED_URL: "https://user:secret@loader.example/news" }), /HTTPS/);
});

const testVideo = id => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom0000"), Buffer.from(String(id))]);
const videoPost = id => ({ ...imported(String(id)), timestamp: `2026-10-${String(id).padStart(2, "0")}T12:00:00Z`, video: { id: String(id), contentType: "video/mp4" } });

test("only the three visible news videos are downloaded, support seeking and are removed when evicted", async t => {
  const downloaded = [];
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news", newsFeedToken: "video-test-only-secret" }, async (value, options) => {
    const url = new URL(value);
    assert.equal(options.headers.Authorization, "Bearer video-test-only-secret");
    if (url.pathname === "/news") return jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [1, 2, 3, 4].map(videoPost) });
    const id = /^\/videos\/(\d+)\.mp4$/.exec(url.pathname)?.[1];
    assert.ok(id); downloaded.push(id);
    const bytes = testVideo(id);
    return new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) } });
  });
  await initialize(f);
  const session = await f.login();
  const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.data.added, 3, "an older loader can return more posts than the site imports");
  assert.equal(result.data.videosAdded, 3);
  assert.deepEqual(downloaded, ["4", "3", "2"]);
  const items = (await f.request("/api/news")).data.items;
  assert.equal(items.length, 3);
  assert.ok(items.every(item => /^\/media\/news-video\/[a-f0-9]{64}\.mp4$/.test(item.video)));
  const oldVideo = items[2].video;
  const range = await f.request(oldVideo, { headers: { Range: "bytes=0-7" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("accept-ranges"), "bytes");
  assert.match(range.headers.get("content-range"), /^bytes 0-7\//);
  const created = await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Новая ручная новость", date: "2026-11-03" } });
  await f.news.syncVideos();
  assert.equal((await f.request(oldVideo)).status, 404);
  await assert.rejects(readFile(path.join(f.config.dataDir, "news-videos", path.basename(oldVideo))), { code: "ENOENT" });
  const archived = f.db.prepare("SELECT title,video,has_video FROM news_items WHERE source_id='2'").get();
  assert.ok(archived.title);
  assert.equal(archived.has_video, 1);
  assert.equal(archived.video, "");
  await f.request(`/api/admin/news/${created.data.item.id}`, { method: "DELETE", ...session, body: {} });
  await f.news.syncVideos();
  assert.equal((await f.request(oldVideo)).status, 200, "a visible archived news item is downloaded again when available");
  assert.equal(downloaded.filter(id => id === "2").length, 2);
});

test("oversized or invalid video leaves a working news card and removes partial files", async t => {
  for (const mode of ["oversized", "invalid"]) {
    const f = await fixture(t, { newsFeedUrl: "https://loader.example/news" }, async value => {
      if (new URL(value).pathname === "/news") return jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [videoPost(1)] });
      return mode === "oversized" ? new Response(testVideo(1), { headers: { "Content-Length": String(100 * 1024 * 1024 + 1) } }) : new Response("<html>not a video</html>");
    });
    await initialize(f);
    const session = await f.login();
    const result = await f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
    assert.equal(result.status, 200);
    assert.equal(result.data.added, 1);
    assert.equal(result.data.videosFailed, 1);
    const item = (await f.request("/api/news")).data.items[0];
    assert.equal(item.video, "");
    assert.ok(item.image);
    const status = (await f.request("/api/admin/news", session)).data;
    assert.equal(status.items[0].video_error, mode === "oversized" ? "video_too_large" : "video_unavailable");
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(path.join(f.config.dataDir, "news-videos")).catch(() => []);
    assert.deepEqual(files, []);
  }
});

test("a video that becomes obsolete during its download is never published or kept", async t => {
  let release, entered, obsoleteAborted = false;
  const gate = new Promise(resolve => { release = resolve; });
  const downloading = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { newsFeedUrl: "https://loader.example/news" }, async (value, options) => {
    if (new URL(value).pathname === "/news") return jsonResponse({ schemaVersion: 1, hashtag: "новости", items: [videoPost(1)] });
    entered();
    await Promise.race([gate, new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { obsoleteAborted = true; reject(new Error("cancelled")); }, { once: true }))]);
    return new Response(testVideo(1));
  });
  await initialize(f);
  const session = await f.login();
  const importing = f.request("/api/admin/news/import", { method: "POST", ...session, body: {} });
  await downloading;
  for (let day = 1; day <= 3; day++) await f.request("/api/admin/news", { method: "POST", ...session, body: { title: `Новая новость ${day}`, date: `2027-01-0${day}` } });
  release();
  const result = await importing;
  await f.news.syncVideos();
  assert.equal(result.data.videosAdded, 0);
  assert.equal(obsoleteAborted, true, "obsolete downloads stop consuming upstream bandwidth");
  assert.equal(f.db.prepare("SELECT video FROM news_items WHERE source_id='1'").get().video, "");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(path.join(f.config.dataDir, "news-videos")).catch(() => []), []);
});

test("backup includes the SQLite snapshot and every referenced local news photo", async t => {
  const f = await fixture(t);
  await initialize(f);
  const session = await f.login();
  const upload = await f.request("/api/admin/news/image", { method: "POST", ...session, body: image });
  await f.request("/api/admin/news", { method: "POST", ...session, body: { title: "Новость для резервной копии", image: upload.data.image } });
  const result = await createBackup(f.db, f.config, path.join(f.config.dataDir, "backups"));
  const snapshot = new DatabaseSync(result.filename, { readOnly: true });
  try {
    const news = snapshot.prepare("SELECT * FROM news_items").get();
    assert.equal(news.title, "Новость для резервной копии");
    const copied = await readFile(path.join(result.mediaDirectory, path.basename(news.image)));
    assert.deepEqual(copied, Buffer.from(PNG, "base64"));
  } finally { snapshot.close(); }
  await assert.rejects(createBackup(f.db, f.config, f.config.publicDir), /вне public/);
});
