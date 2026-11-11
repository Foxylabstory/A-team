import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { collectInstagram } from "./instagram.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicNewsService } from "./public-service.js";
import { relayInstagramVideo } from "./video.js";

const secret = process.env.NEWS_LOADER_TOKEN || "";
if (secret.length < 32) throw new Error("Set NEWS_LOADER_TOKEN to at least 32 random characters.");
const config = {
  instagramUser: process.env.IG_USER_ID, instagramToken: process.env.IG_ACCESS_TOKEN,
  instagramLogin: process.env.IG_LOGIN || "facebook", instagramVersion: process.env.IG_API_VERSION || "v25.0",
  instagramHashtag: (process.env.IG_NEWS_HASHTAG || "новости").replace(/^#/, "").normalize("NFKC").toLowerCase(),
  instagramUsername: (process.env.IG_NEWS_ACCOUNT || "").replace(/^@/, "").toLowerCase(),
  instagramPython: process.env.IG_PYTHON || "python3",
  instagramScanLimit: Number(process.env.IG_SCAN_LIMIT || 100),
  instagramSessionFile: process.env.IG_SESSION_FILE || "",
  loaderDataDir: path.resolve(fileURLToPath(new URL("./", import.meta.url)), process.env.NEWS_LOADER_DATA_DIR || "private")
};
const source = process.env.IG_SOURCE || "official";
if (!["official", "instaloader"].includes(source)) throw new Error("IG_SOURCE must be official or instaloader.");
if (!/^[\p{L}\p{N}_]{1,80}$/u.test(config.instagramHashtag) || !/^v\d+\.0$/.test(config.instagramVersion)) throw new Error("Invalid Instagram settings.");
if (source === "official" && (!["facebook", "instagram"].includes(config.instagramLogin) || !/^\d+$/.test(config.instagramUser || "") || !config.instagramToken)) throw new Error("Configure a professional Instagram account and matching login type.");
if (config.instagramUsername && !/^[a-z0-9._]{1,30}$/.test(config.instagramUsername)) throw new Error("Invalid IG_NEWS_ACCOUNT.");
if (source === "instaloader" && (!config.instagramUsername || !Number.isInteger(config.instagramScanLimit) || config.instagramScanLimit < 1 || config.instagramScanLimit > 500)) throw new Error("Configure IG_NEWS_ACCOUNT and IG_SCAN_LIMIT (1..500).");
const publicNews = source === "instaloader" ? createPublicNewsService(config) : null;
let running = false;
let lastAttempt = 0;
const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/health" && req.method === "GET") { res.end('{"ok":true}'); return; }
  const token = Buffer.from(req.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (token.length !== expected.length || !timingSafeEqual(token, expected)) { res.writeHead(401); res.end('{"ok":false}'); return; }
  const video = /^\/videos\/(\d{1,40})\.mp4$/.exec(req.url);
  if (video && req.method === "GET" && publicNews) {
    const url = publicNews.videoUrl(video[1]);
    if (!url) { res.writeHead(404); res.end('{"ok":false}'); return; }
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", disconnected);
    try { await relayInstagramVideo(url, res, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]) }); }
    catch (error) {
      if (!res.headersSent && !res.destroyed) { res.removeHeader("Content-Length"); res.setHeader("Content-Type", "application/json"); res.writeHead(error.message === "video_too_large" ? 413 : 502); res.end('{"ok":false}'); }
      else res.destroy();
    } finally { res.off("close", disconnected); }
    return;
  }
  if (req.url !== "/news" || req.method !== "GET") { res.writeHead(404); res.end('{"ok":false}'); return; }
  if (publicNews) {
    try {
      const result = publicNews.read({ force: req.headers["x-news-refresh"] === "1" });
      if (result.status === 202) res.setHeader("Retry-After", "10");
      res.writeHead(result.status); res.end(JSON.stringify(result.body));
    } catch { res.writeHead(502); res.end('{"ok":false,"error":"instagram_unavailable"}'); }
    return;
  }
  if (running || Date.now() - lastAttempt < 60000) { res.writeHead(429); res.end('{"ok":false,"error":"too_many"}'); return; }
  running = true;
  lastAttempt = Date.now();
  try { res.end(JSON.stringify({ ok: true, ...await collectInstagram(config) })); }
  catch (error) {
    const code = ["instagram_auth", "instagram_account_mismatch"].includes(error.message) ? error.message : "instagram_unavailable";
    res.writeHead(502); res.end(JSON.stringify({ ok: false, error: code }));
  }
  finally { running = false; }
}).listen(Number(process.env.PORT || 3100), process.env.HOST || "127.0.0.1", () => console.log(`Instagram news loader ready (${source}); no lead data is handled.`));
function shutdown() { server.close(async () => { await publicNews?.stop(); }); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
