import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const VIDEO_LIMIT = 100 * 1024 * 1024;

export function videoValidator({ limit = VIDEO_LIMIT, onChunk = () => {} } = {}) {
  let length = 0, header = Buffer.alloc(0), checked = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      length += chunk.length;
      if (length > limit) return done(new Error("video_too_large"));
      if (!checked) {
        header = Buffer.concat([header, chunk.subarray(0, Math.max(0, 12 - header.length))]);
        if (header.length >= 12) {
          if (header.toString("ascii", 4, 8) !== "ftyp") return done(new Error("video_unavailable"));
          checked = true;
        }
      }
      onChunk(chunk);
      done(null, chunk);
    },
    flush(done) { done(checked ? undefined : new Error("video_unavailable")); }
  });
}

export async function relayInstagramVideo(address, destination, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(address);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !["cdninstagram.com", "fbcdn.net"].some(domain => url.hostname === domain || url.hostname.endsWith("." + domain))) throw new Error("video_unavailable");
  const response = await fetchImpl(url, { headers: { Accept: "video/mp4" }, redirect: "error", signal });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("video_unavailable"); }
  if (Number(response.headers.get("content-length")) > VIDEO_LIMIT) { await response.body.cancel(); throw new Error("video_too_large"); }
  destination.setHeader("Content-Type", "video/mp4");
  const length = Number(response.headers.get("content-length"));
  if (Number.isSafeInteger(length) && length > 0) destination.setHeader("Content-Length", String(length));
  await pipeline(Readable.fromWeb(response.body), videoValidator(), destination, { signal });
}
