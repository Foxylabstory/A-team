import fs from "node:fs/promises";
import { createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VIDEO_LIMIT, videoValidator } from "../instagram-loader/video.js";

export const PUBLIC_NEWS_LIMIT = 3;
export const VIDEO_PREFIX = "/media/news-video/";
export const VIDEO_FILE = /^[a-f0-9]{64}\.mp4$/;

export function createNewsVideos(db, config, fetchImpl) {
  const directory = path.join(config.dataDir, "news-videos");
  const active = () => db.prepare(`SELECT id,source_id,video,has_video,video_error FROM news_items WHERE hidden=0
    ORDER BY published_at DESC,created_at DESC,id DESC LIMIT ${PUBLIC_NEWS_LIMIT}`).all();
  let running, again = false, controller, timer, stopped = false, downloading = false;
  let transferController, transferId;
  const pendingFiles = new Set();

  function available(row) {
    const filename = row.video?.startsWith(VIDEO_PREFIX) ? row.video.slice(VIDEO_PREFIX.length) : "";
    return row.has_video && VIDEO_FILE.test(filename) && existsSync(path.join(directory, filename)) ? row.video : "";
  }
  async function prune() {
    const keep = new Set(active().filter(row => row.has_video && row.video.startsWith(VIDEO_PREFIX)).map(row => row.video.slice(VIDEO_PREFIX.length)));
    for (const filename of pendingFiles) keep.add(filename);
    const files = await fs.readdir(directory).catch(error => { if (error.code !== "ENOENT") throw error; return []; });
    for (const filename of files) {
      if (VIDEO_FILE.test(filename) && !keep.has(filename)) await fs.rm(path.join(directory, filename), { force: true }).catch(error => {
        if (!["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      });
      if (/^\.part-[a-f0-9-]{36}$/.test(filename)) {
        const stat = await fs.stat(path.join(directory, filename)).catch(() => null);
        if (stat && stat.mtimeMs < Date.now() - 3600000) await fs.rm(path.join(directory, filename), { force: true }).catch(() => {});
      }
    }
    for (const row of db.prepare("SELECT id,video FROM news_items WHERE video<>''").all()) {
      if (!keep.has(row.video.slice(VIDEO_PREFIX.length))) db.prepare("UPDATE news_items SET video='',video_error='' WHERE id=?").run(row.id);
    }
  }
  async function download(row, signal) {
    if (!config.newsFeedUrl || !/^\d{1,40}$/.test(row.source_id || "")) throw new Error("video_unavailable");
    const url = new URL(`videos/${row.source_id}.mp4`, config.newsFeedUrl);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.newsFeedToken}` }, redirect: "error", signal });
    if (response.status === 413 || Number(response.headers.get("content-length")) > VIDEO_LIMIT) { await response.body?.cancel(); throw new Error("video_too_large"); }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("video_unavailable"); }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.part-${randomUUID()}`);
    const hash = createHash("sha256");
    let target, filename;
    try {
      await pipeline(Readable.fromWeb(response.body), videoValidator({ onChunk: chunk => hash.update(chunk) }),
        createWriteStream(temporary, { flags: "wx", mode: 0o600 }), { signal });
      filename = hash.digest("hex") + ".mp4";
      pendingFiles.add(filename);
      target = path.join(directory, filename);
      if (existsSync(target)) await fs.rm(temporary, { force: true });
      else await fs.rename(temporary, target);
      const current = active().find(item => item.id === row.id && item.has_video);
      if (!current) return false;
      db.prepare("UPDATE news_items SET video=?,video_error='' WHERE id=?").run(VIDEO_PREFIX + filename, row.id);
      return true;
    } finally { if (filename) pendingFiles.delete(filename); await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  function sync() {
    if (stopped) return Promise.resolve({ videosAdded: 0, videosFailed: 0 });
    if (running) {
      again = true;
      if (transferId && !active().some(row => row.id === transferId && row.has_video)) transferController?.abort();
      return running;
    }
    controller = new AbortController();
    running = (async () => {
      const result = { videosAdded: 0, videosFailed: 0 };
      do {
        again = false;
        await prune();
        for (const row of active()) {
          if (controller.signal.aborted) break;
          if (!row.has_video || available(row) || row.video_error || !config.newsFeedUrl) continue;
          try {
            downloading = true;
            transferController = new AbortController(); transferId = row.id;
            if (await download(row, AbortSignal.any([controller.signal, transferController.signal, AbortSignal.timeout(300000)]))) result.videosAdded++;
          } catch (error) {
            if (controller.signal.aborted) break;
            if (!active().some(item => item.id === row.id && item.has_video)) continue;
            db.prepare("UPDATE news_items SET video_error=? WHERE id=?").run(error.message === "video_too_large" ? "video_too_large" : "video_unavailable", row.id);
            result.videosFailed++;
          } finally { downloading = false; transferController = undefined; transferId = undefined; }
        }
        await prune();
      } while (again && !controller.signal.aborted);
      return result;
    })().finally(() => { running = undefined; controller = undefined; downloading = false; });
    return running;
  }
  const queue = () => { void sync().catch(() => console.warn("Видео новостей: не удалось завершить обработку файлов.")); };
  return { directory, available, active, sync, queue,
    get running() { return !!running; },
    get downloading() { return downloading; },
    start() {
      if (timer) return;
      stopped = false;
      queue();
      timer = setInterval(() => { void prune().catch(() => {}); }, 60000); timer.unref();
    },
    async stop() { stopped = true; clearInterval(timer); timer = undefined; controller?.abort(); await running?.catch(() => {}); }
  };
}
