import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(".");
const NEWS_FILE = path.join(ROOT, "data", "news.json");

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(ROOT, "public")));

/* ---------- простая защита от спама: 5 заявок с IP за 10 минут ---------- */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

/* ---------- заявки → Telegram ---------- */
app.post("/api/lead", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (rateLimited(ip)) return res.status(429).json({ ok: false, error: "too_many" });

  const name = String(req.body?.name || "").trim().slice(0, 80);
  const phone = String(req.body?.phone || "").trim().slice(0, 40);
  const consent = req.body?.consent === true;
  const honeypot = String(req.body?.company || "");

  if (honeypot) return res.json({ ok: true }); // бот
  if (!name || !phone) return res.status(400).json({ ok: false, error: "empty" });
  if (!consent) return res.status(400).json({ ok: false, error: "no_consent" });

  const text =
    "🥊 Заявка с сайта ANTIPOV TEAM\n" +
    `Имя: ${name}\n` +
    `Телефон: ${phone}\n` +
    `Согласие на обработку ПД: да\n` +
    `Время: ${new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })}`;

  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: process.env.TG_CHAT_ID, text })
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ ok: true });
  } catch (e) {
    console.error("telegram", e.message);
    res.status(502).json({ ok: false, error: "telegram" });
  }
});

/* ---------- новости: Instagram + ручные ---------- */
let igCache = { at: 0, items: [] };

async function fetchInstagram() {
  const ttl = (Number(process.env.IG_CACHE_MINUTES) || 30) * 60 * 1000;
  if (Date.now() - igCache.at < ttl) return igCache.items;
  if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) return [];

  const url =
    `https://graph.facebook.com/v20.0/${process.env.IG_USER_ID}/media` +
    `?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp` +
    `&limit=9&access_token=${process.env.IG_ACCESS_TOKEN}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!data.data) throw new Error(data.error?.message || "no data");
    igCache = {
      at: Date.now(),
      items: data.data.map((m) => {
        const caption = (m.caption || "").trim();
        const firstLine = caption.split("\n")[0].slice(0, 70);
        return {
          source: "Instagram",
          date: new Date(m.timestamp).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }),
          title: firstLine || "Публикация клуба",
          text: caption.slice(firstLine.length).trim().slice(0, 180),
          image: m.media_type === "VIDEO" ? m.thumbnail_url : m.media_url,
          link: m.permalink
        };
      })
    };
    return igCache.items;
  } catch (e) {
    console.error("instagram", e.message);
    return igCache.items;
  }
}

async function readManual() {
  try {
    return JSON.parse(await fs.readFile(NEWS_FILE, "utf8"));
  } catch {
    return [];
  }
}

app.get("/api/news", async (_req, res) => {
  const [manual, ig] = await Promise.all([readManual(), fetchInstagram()]);
  res.set("Cache-Control", "public, max-age=300");
  res.json({ ok: true, items: [...manual, ...ig].slice(0, 12) });
});

/* ---------- админка: добавить/удалить ручную новость ---------- */
const adminHits = new Map();
function auth(req, res, next) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  const now = Date.now();
  const tries = (adminHits.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (tries.length > 10) return res.status(429).json({ ok: false, error: "too_many" });
  if (!process.env.ADMIN_TOKEN || req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    tries.push(now);
    adminHits.set(ip, tries);
    return res.status(401).json({ ok: false });
  }
  next();
}

app.get("/api/admin/check", auth, (_req, res) => res.json({ ok: true }));

app.post("/api/news", auth, async (req, res) => {
  const list = await readManual();
  const item = {
    id: Date.now().toString(36),
    source: "Клуб",
    date: String(req.body?.date || new Date().toLocaleDateString("ru-RU")).slice(0, 40),
    title: String(req.body?.title || "").slice(0, 120),
    text: String(req.body?.text || "").slice(0, 400),
    image: String(req.body?.image || "")
  };
  const next = [item, ...list].slice(0, 30);
  await fs.mkdir(path.dirname(NEWS_FILE), { recursive: true });
  await fs.writeFile(NEWS_FILE, JSON.stringify(next, null, 2));
  res.json({ ok: true, item });
});

app.delete("/api/news/:id", auth, async (req, res) => {
  const list = await readManual();
  await fs.writeFile(NEWS_FILE, JSON.stringify(list.filter((n) => n.id !== req.params.id), null, 2));
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`ANTIPOV TEAM site → http://localhost:${PORT}`));
