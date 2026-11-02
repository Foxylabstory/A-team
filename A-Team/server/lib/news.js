import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { audit, transaction } from "./database.js";
import { findSession } from "./auth.js";
import { collectInstagram, hashtagPattern } from "../instagram-loader/instagram.js";
import { IMAGE_LIMIT, imageType, readLimited } from "../instagram-loader/images.js";

const MEDIA_PREFIX = "/media/news/";
const FILE = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function migrateLegacy(db, dataDir) {
  if (db.prepare("SELECT value FROM settings WHERE key='legacy_news_migrated'").get()) return;
  let old = [];
  try { old = JSON.parse(readFileSync(path.join(dataDir, "news.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!Array.isArray(old)) throw new Error("Legacy news.json must contain an array; migration was not applied.");
  transaction(db, () => {
    for (let i = 0; i < old.length; i++) {
      const item = old[i];
      const now = Date.now() - i;
      const id = typeof item.id === "string" && item.id ? item.id : randomUUID();
      db.prepare(`INSERT OR IGNORE INTO news_items(id,source,published_at,display_date,title,text,image,created_at,updated_at)
        VALUES(?,'manual',?,?,?,?,?,?,?)`).run(id, Number.isFinite(Date.parse(item.date)) ? Date.parse(item.date) : now,
          String(item.date || today()).slice(0, 40), String(item.title || "Новость клуба").slice(0, 120),
          String(item.text || "").slice(0, 2000), /^https:\/\//i.test(item.image || "") ? String(item.image) : "", now, now);
    }
    db.prepare("INSERT INTO settings VALUES('legacy_news_migrated','1')").run();
  });
}

export function installNews(app, { db, config, auth, asyncRoute, fetchImpl, limit }) {
  migrateLegacy(db, config.dataDir);
  const directory = path.join(config.dataDir, "news-images");
  let importing = false;
  const importMode = config.newsFeedUrl ? "loader" : config.instagramUser && config.instagramToken ? "direct" : "none";
  const get = id => db.prepare("SELECT * FROM news_items WHERE id=?").get(id);

  async function cleanupUploads() {
    const rows = db.prepare(`SELECT filename FROM news_uploads WHERE created_at<? AND NOT EXISTS
      (SELECT 1 FROM news_items WHERE image=? || news_uploads.filename) LIMIT 100`).all(Date.now() - 86400000, MEDIA_PREFIX);
    for (const row of rows) {
      await fs.rm(path.join(directory, row.filename), { force: true });
      db.prepare("DELETE FROM news_uploads WHERE filename=?").run(row.filename);
    }
  }
  async function storeImage(image) {
    if (!image || typeof image.data !== "string" || image.data.length > Math.ceil(IMAGE_LIMIT / 3) * 4) throw new Error("invalid_image");
    const bytes = Buffer.from(image.data, "base64");
    if (bytes.toString("base64") !== image.data) throw new Error("invalid_image");
    const info = imageType(bytes);
    if (image.type !== info.type) throw new Error("invalid_image");
    const filename = `${createHash("sha256").update(bytes).digest("hex")}.${info.extension}`;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try { await fs.writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    db.prepare("INSERT OR IGNORE INTO news_uploads VALUES(?,?)").run(filename, Date.now());
    return MEDIA_PREFIX + filename;
  }
  async function manualFields(body, previous) {
    const { title, text = "", image = "", date = today() } = body || {};
    if (typeof title !== "string" || !title.trim() || title.trim().length > 120 || typeof text !== "string" || text.length > 2000) throw new Error("invalid_news");
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("invalid_date");
    if (typeof image !== "string") throw new Error("invalid_image");
    if (image && image !== previous?.image) {
      const filename = image.startsWith(MEDIA_PREFIX) ? image.slice(MEDIA_PREFIX.length) : "";
      if (!FILE.test(filename) || !db.prepare("SELECT filename FROM news_uploads WHERE filename=?").get(filename)) throw new Error("invalid_image");
      await fs.access(path.join(directory, filename));
    }
    return { title: title.trim(), text: text.trim(), image, display_date: date, published_at: Date.parse(`${date}T12:00:00+03:00`) };
  }
  function publicItem(row) {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(row.display_date)
      ? new Date(row.published_at).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Moscow" }) : row.display_date;
    return { id: row.id, source: row.source === "instagram" ? "Instagram" : "Клуб", date, title: row.title, text: row.text, image: row.image, link: row.link };
  }
  async function fetchImport() {
    if (importMode === "none") throw new Error("instagram_not_configured");
    if (importMode === "direct") return collectInstagram(config, fetchImpl);
    const response = await fetchImpl(config.newsFeedUrl, { headers: { Authorization: `Bearer ${config.newsFeedToken}` },
      signal: AbortSignal.timeout(60000), redirect: "error" });
    return JSON.parse((await readLimited(response, 18 * 1024 * 1024)).toString("utf8"));
  }
  async function importItems(payload) {
    if (payload.schemaVersion !== 1 || payload.hashtag !== config.instagramHashtag || !Array.isArray(payload.items) || payload.items.length > 6) throw new Error("instagram_response");
    const prepared = [];
    const seen = new Set();
    let skipped = 0;
    for (const item of payload.items) {
      if (!/^\d{1,40}$/.test(item.id || "") || typeof item.caption !== "string" || item.caption.length > 10000 ||
          !Number.isFinite(Date.parse(item.timestamp)) || !hashtagPattern(config.instagramHashtag).test(item.caption.normalize("NFKC"))) throw new Error("instagram_response");
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const previous = db.prepare("SELECT * FROM news_items WHERE source_id=?").get(item.id);
      if (previous?.hidden) { skipped++; continue; }
      let link = "";
      if (item.link) {
        const url = new URL(item.link);
        if (url.protocol !== "https:" || !["www.instagram.com", "instagram.com"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("instagram_response");
        link = url.href;
      }
      const clean = item.caption.normalize("NFKC").replace(hashtagPattern(config.instagramHashtag), "").trim();
      const lines = clean.split("\n");
      const title = (lines.shift()?.trim() || "Новость клуба").slice(0, 120);
      const publishedAt = Date.parse(item.timestamp);
      prepared.push({ sourceId: item.id, id: previous?.id || `instagram:${item.id}`, title, text: lines.join("\n").trim().slice(0, 2000),
        publishedAt, date: new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(publishedAt)),
        image: item.image ? await storeImage(item.image) : "", link, existed: !!previous });
    }
    let added = 0;
    let updated = 0;
    transaction(db, () => {
      const statement = db.prepare(`INSERT INTO news_items(id,source,source_id,published_at,display_date,title,text,image,link,created_at,updated_at)
        VALUES(?,'instagram',?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET
        published_at=excluded.published_at,display_date=excluded.display_date,title=excluded.title,text=excluded.text,
        image=excluded.image,link=excluded.link,updated_at=excluded.updated_at WHERE news_items.hidden=0`);
      for (const item of prepared) {
        // Re-check visibility after network/file operations: a concurrent deletion must win.
        if (db.prepare("SELECT hidden FROM news_items WHERE source_id=?").get(item.sourceId)?.hidden) { skipped++; continue; }
        statement.run(item.id, item.sourceId, item.publishedAt, item.date, item.title, item.text, item.image, item.link, Date.now(), Date.now());
        if (item.existed) updated++; else added++;
      }
      db.prepare("INSERT INTO settings VALUES('news_last_import',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()));
      audit(db, "news_instagram_imported");
    });
    return { added, updated, skipped, found: seen.size, truncated: payload.truncated === true };
  }

  app.get("/media/news/:filename", asyncRoute(async (req, res) => {
    if (!FILE.test(req.params.filename)) return res.sendStatus(404);
    const image = MEDIA_PREFIX + req.params.filename;
    const visible = db.prepare("SELECT id FROM news_items WHERE image=? AND hidden=0 LIMIT 1").get(image);
    if (!visible && !findSession(db, req.headers.cookie)) return res.sendStatus(404);
    res.set("Cache-Control", visible ? "public, max-age=60" : "no-store");
    res.sendFile(req.params.filename, { root: directory, dotfiles: "deny" });
  }));
  app.get("/api/news", (_req, res) => {
    const rows = db.prepare("SELECT * FROM news_items WHERE hidden=0 ORDER BY published_at DESC,created_at DESC,id DESC LIMIT 6").all();
    res.set("Cache-Control", "no-store").json({ ok: true, items: rows.map(publicItem) });
  });
  app.get("/api/admin/news", auth, (req, res) => {
    const filter = req.query.filter || "all";
    if (!["all", "manual", "instagram", "hidden"].includes(filter)) return res.status(400).json({ ok: false, error: "invalid_filter" });
    const page = Number(req.query.page || 1);
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) return res.status(400).json({ ok: false, error: "invalid_page" });
    const where = filter === "hidden" ? "hidden=1" : filter === "all" ? "hidden=0" : "hidden=0 AND source=?";
    const args = ["manual", "instagram"].includes(filter) ? [filter] : [];
    const total = db.prepare(`SELECT count(*) AS n FROM news_items WHERE ${where}`).get(...args).n;
    const items = db.prepare(`SELECT * FROM news_items WHERE ${where} ORDER BY published_at DESC,created_at DESC,id DESC LIMIT 25 OFFSET ?`).all(...args, (page - 1) * 25);
    res.json({ ok: true, items, total, page, pageSize: 25, importConfigured: importMode !== "none", importMode,
      hashtag: config.instagramHashtag, lastImport: Number(db.prepare("SELECT value FROM settings WHERE key='news_last_import'").get()?.value || 0) });
  });
  app.post("/api/admin/news/image", auth, asyncRoute(async (req, res) => {
    if (limit(req, res, "news-image", 20, 60000)) return;
    try { await cleanupUploads(); res.json({ ok: true, image: await storeImage(req.body) }); }
    catch (error) { if (error.message !== "invalid_image") throw error; res.status(400).json({ ok: false, error: "invalid_image" }); }
  }));
  const create = asyncRoute(async (req, res) => {
    let item;
    try { item = await manualFields(req.body); }
    catch (error) { if (!["invalid_news", "invalid_date", "invalid_image"].includes(error.message)) throw error; return res.status(400).json({ ok: false, error: error.message }); }
    const id = randomUUID();
    transaction(db, () => {
      db.prepare(`INSERT INTO news_items(id,source,published_at,display_date,title,text,image,created_at,updated_at) VALUES(?,'manual',?,?,?,?,?,?,?)`)
        .run(id, item.published_at, item.display_date, item.title, item.text, item.image, Date.now(), Date.now());
      audit(db, "news_created", id);
    });
    res.json({ ok: true, item: publicItem(get(id)) });
  });
  app.post("/api/admin/news", auth, create);
  app.post("/api/news", auth, create);
  app.patch("/api/admin/news/:id", auth, asyncRoute(async (req, res) => {
    const previous = get(req.params.id);
    if (!previous) return res.status(404).json({ ok: false, error: "not_found" });
    if (typeof req.body?.hidden === "boolean") {
      db.prepare("UPDATE news_items SET hidden=?,updated_at=? WHERE id=?").run(Number(req.body.hidden), Date.now(), previous.id);
      audit(db, req.body.hidden ? "news_hidden" : "news_restored", previous.id);
      return res.json({ ok: true });
    }
    if (previous.source !== "manual") return res.status(400).json({ ok: false, error: "instagram_readonly" });
    let item;
    try { item = await manualFields(req.body, previous); }
    catch (error) { if (!["invalid_news", "invalid_date", "invalid_image"].includes(error.message)) throw error; return res.status(400).json({ ok: false, error: error.message }); }
    db.prepare("UPDATE news_items SET title=?,text=?,image=?,display_date=?,published_at=?,updated_at=? WHERE id=?")
      .run(item.title, item.text, item.image, item.display_date, item.published_at, Date.now(), previous.id);
    audit(db, "news_edited", previous.id);
    res.json({ ok: true });
  }));
  const remove = (req, res) => {
    const previous = get(req.params.id);
    if (!previous) return res.status(404).json({ ok: false, error: "not_found" });
    transaction(db, () => {
      if (previous.source === "instagram") db.prepare("UPDATE news_items SET hidden=1,updated_at=? WHERE id=?").run(Date.now(), previous.id);
      else db.prepare("DELETE FROM news_items WHERE id=?").run(previous.id);
      audit(db, previous.source === "instagram" ? "news_hidden" : "news_deleted", previous.id);
    });
    res.json({ ok: true, hidden: previous.source === "instagram" });
  };
  app.delete("/api/admin/news/:id", auth, remove);
  app.delete("/api/news/:id", auth, remove);
  app.post("/api/admin/news/import", auth, asyncRoute(async (req, res) => {
    if (importMode === "none") return res.status(409).json({ ok: false, error: "instagram_not_configured" });
    if (importing) return res.status(409).json({ ok: false, error: "import_busy" });
    if (limit(req, res, "news-import", 1, 60000, "all")) return;
    importing = true;
    try { const result = await importItems(await fetchImport()); res.json({ ok: true, ...result }); }
    catch { res.status(502).json({ ok: false, error: "instagram_unavailable" }); }
    finally { importing = false; }
  }));
}
