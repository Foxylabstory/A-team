import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { collectInstagram } from "./instagram.js";

const secret = process.env.NEWS_LOADER_TOKEN || "";
if (secret.length < 32) throw new Error("Set NEWS_LOADER_TOKEN to at least 32 random characters.");
const config = {
  instagramUser: process.env.IG_USER_ID, instagramToken: process.env.IG_ACCESS_TOKEN,
  instagramLogin: process.env.IG_LOGIN || "facebook", instagramVersion: process.env.IG_API_VERSION || "v25.0",
  instagramHashtag: (process.env.IG_NEWS_HASHTAG || "новости").replace(/^#/, "").normalize("NFKC").toLowerCase()
};
if (!/^[\p{L}\p{N}_]{1,80}$/u.test(config.instagramHashtag) || !/^v\d+\.0$/.test(config.instagramVersion)) throw new Error("Invalid Instagram settings.");
if (!["facebook", "instagram"].includes(config.instagramLogin) || !/^\d+$/.test(config.instagramUser || "") || !config.instagramToken) throw new Error("Configure a professional Instagram account and matching login type.");
let running = false;
let lastAttempt = 0;
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  const token = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) { res.writeHead(401); res.end('{"ok":false}'); return; }
  if (req.url !== "/news" || req.method !== "GET") { res.writeHead(404); res.end('{"ok":false}'); return; }
  if (running || Date.now() - lastAttempt < 60000) { res.writeHead(429); res.end('{"ok":false,"error":"too_many"}'); return; }
  running = true;
  lastAttempt = Date.now();
  try { res.end(JSON.stringify({ ok: true, ...await collectInstagram(config) })); }
  catch { res.writeHead(502); res.end('{"ok":false,"error":"instagram_unavailable"}'); }
  finally { running = false; }
}).listen(Number(process.env.PORT || 3100), process.env.HOST || "127.0.0.1", () => console.log("Instagram news loader ready; no lead data is handled."));
