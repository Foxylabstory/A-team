import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { collectWithInstaloader, INSTALOADER_ERRORS } from "./instaloader.js";

export function createPublicNewsService(config, { collect = collectWithInstaloader, now = Date.now } = {}) {
  const filename = path.join(config.loaderDataDir, "instaloader-feed.json");
  const stateFile = path.join(config.loaderDataDir, "instaloader-state.json");
  let cache, lastAttempt = 0, lastError = "", inFlight, controller;
  const valid = value => value?.schemaVersion === 1 && value.accountUsername === config.instagramUsername && value.hashtag === config.instagramHashtag &&
    Array.isArray(value.items) && value.items.length <= 6 && Number.isFinite(Date.parse(value.generatedAt));
  try { const value = JSON.parse(readFileSync(filename, "utf8")); if (valid(value)) cache = value; } catch {}
  try { const state = JSON.parse(readFileSync(stateFile, "utf8")); lastAttempt = Number(state.lastAttempt) || 0; lastError = state.lastError || ""; } catch {}
  function save(target, value) {
    mkdirSync(config.loaderDataDir, { recursive: true, mode: 0o700 });
    writeFileSync(target + ".tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync(target + ".tmp", target);
  }
  function refresh() {
    lastAttempt = now();
    save(stateFile, { lastAttempt, lastError });
    controller = new AbortController();
    inFlight = (async () => {
      try {
        const value = { ...await collect(config, { signal: controller.signal }), generatedAt: new Date(now()).toISOString() };
        if (!valid(value)) throw new Error("instagram_unavailable");
        save(filename, value);
        cache = value;
        lastError = "";
      } catch (error) {
        lastError = INSTALOADER_ERRORS.includes(error.message) ? error.message : "instagram_unavailable";
      } finally {
        try { save(stateFile, { lastAttempt, lastError }); } finally { inFlight = undefined; controller = undefined; }
      }
    })();
    // A request only starts background work; a disconnected visitor cannot cancel the import.
    void inFlight.catch(() => {});
  }
  const publicFeed = value => ({ schemaVersion: 1, hashtag: value.hashtag, accountUsername: value.accountUsername,
    generatedAt: value.generatedAt, scanned: value.scanned, scanLimit: value.scanLimit, truncated: value.truncated,
    items: value.items.map(item => ({ id: item.id, caption: item.caption, timestamp: item.timestamp, link: item.link, image: item.image,
      video: item.videoUrl || item.videoUnavailable ? { id: item.id, contentType: "video/mp4" } : null })) });
  return {
    videoUrl(id) { return cache?.items.find(item => item.id === id)?.videoUrl || ""; },
    read({ force = false } = {}) {
      if (inFlight) return { status: 202, body: { ok: true, pending: true } };
      if (lastError && now() - lastAttempt < 3600000) return { status: 502, body: { ok: false, error: lastError } };
      if (cache && !force && !lastError && now() - Date.parse(cache.generatedAt) < 86400000) return { status: 200, body: { ok: true, ...publicFeed(cache) } };
      if (now() - lastAttempt < (lastError ? 3600000 : 60000)) {
        if (cache && !lastError) return { status: 200, body: { ok: true, ...publicFeed(cache) } };
        return { status: 502, body: { ok: false, error: lastError || "instagram_unavailable" } };
      }
      refresh();
      return { status: 202, body: { ok: true, pending: true } };
    },
    status: () => ({ running: !!inFlight, lastAttempt, lastError }),
    async stop() { controller?.abort(); await inFlight?.catch(() => {}); }
  };
}
