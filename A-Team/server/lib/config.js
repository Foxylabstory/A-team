import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function loadConfig(env = process.env) {
  if (env === process.env) dotenv.config({ path: path.join(ROOT, ".env") });
  const production = env.NODE_ENV === "production";
  const siteUrl = env.SITE_URL ? new URL(env.SITE_URL) : null;
  if (siteUrl && (siteUrl.username || siteUrl.password || siteUrl.search || siteUrl.hash ||
      siteUrl.pathname !== "/" || !["http:", "https:"].includes(siteUrl.protocol))) {
    throw new Error("SITE_URL must be an http(s) origin without a path or credentials.");
  }
  if (production && siteUrl?.protocol !== "https:") {
    throw new Error("Production requires SITE_URL=https://your-domain.ru and HTTPS.");
  }
  const dataDir = path.resolve(ROOT, env.DATA_DIR || "data");
  const publicDir = path.join(ROOT, "public");
  const relative = path.relative(publicDir, dataDir);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("DATA_DIR must be outside public/.");
  }
  const retentionDays = Number(env.LEAD_RETENTION_DAYS || 90);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("LEAD_RETENTION_DAYS must be an integer between 1 and 3650.");
  }
  if (Boolean(env.TG_BOT_TOKEN) !== Boolean(env.TG_CHAT_ID)) {
    throw new Error("Set both TG_BOT_TOKEN and TG_CHAT_ID, or leave both empty.");
  }
  const newsFeedUrl = env.IG_NEWS_FEED_URL || "";
  if (newsFeedUrl) {
    const url = new URL(newsFeedUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("IG_NEWS_FEED_URL must be HTTPS without credentials.");
    if (!env.IG_NEWS_FEED_TOKEN || env.IG_NEWS_FEED_TOKEN.length < 32) throw new Error("IG_NEWS_FEED_TOKEN needs at least 32 characters.");
  }
  const instagramVersion = env.IG_API_VERSION || "v25.0";
  if (!/^v\d+\.0$/.test(instagramVersion)) throw new Error("Invalid IG_API_VERSION.");
  const instagramLogin = env.IG_LOGIN || "facebook";
  if (!["facebook", "instagram"].includes(instagramLogin)) throw new Error("IG_LOGIN must be facebook or instagram.");
  const instagramHashtag = (env.IG_NEWS_HASHTAG || "новости").replace(/^#/, "").normalize("NFKC").toLowerCase();
  if (!/^[\p{L}\p{N}_]{1,80}$/u.test(instagramHashtag)) throw new Error("Invalid IG_NEWS_HASHTAG.");
  return {
    root: ROOT, publicDir, dataDir, dbPath: path.join(dataDir, "club.sqlite"),
    production, siteUrl: siteUrl?.origin || "", retentionDays,
    host: env.HOST || "127.0.0.1", port: Number(env.PORT || 3000),
    trustProxy: env.TRUST_PROXY === "loopback" ? "loopback" : false,
    telegramToken: env.TG_BOT_TOKEN || "", telegramChat: env.TG_CHAT_ID || "",
    instagramUser: env.IG_USER_ID || "", instagramToken: env.IG_ACCESS_TOKEN || "",
    instagramVersion, instagramLogin, instagramHashtag, newsFeedUrl,
    newsFeedToken: env.IG_NEWS_FEED_TOKEN || "",
    sessionHours: 8
  };
}
