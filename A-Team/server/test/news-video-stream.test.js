import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { videoValidator, relayInstagramVideo } from "../instagram-loader/video.js";

const clip = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from("ftypisom0000test")]);
function output() {
  const chunks = [], headers = {};
  const stream = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  stream.setHeader = (key, value) => { headers[key] = value; };
  return { stream, chunks, headers };
}
test("video relay accepts only Instagram CDN hosts and does not forward club credentials", async () => {
  for (const url of ["http://cdninstagram.com/video.mp4", "https://cdninstagram.com.evil.test/video.mp4", "https://user:secret@cdninstagram.com/video.mp4"]) {
    await assert.rejects(relayInstagramVideo(url, output().stream, { fetchImpl: async () => { throw new Error("must not request"); } }), /video_unavailable/);
  }
  const destination = output();
  await relayInstagramVideo("https://scontent.cdninstagram.com/video.mp4", destination.stream, { fetchImpl: async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.redirect, "error");
    return new Response(clip, { headers: { "Content-Length": String(clip.length) } });
  } });
  assert.deepEqual(Buffer.concat(destination.chunks), clip);
  assert.equal(destination.headers["Content-Type"], "video/mp4");
});
test("video size is enforced while streaming and malformed files are rejected", async () => {
  await assert.rejects(pipeline(Readable.from([clip, Buffer.alloc(40)]), videoValidator({ limit: 32 }), output().stream), /video_too_large/);
  await assert.rejects(pipeline(Readable.from([Buffer.from("<html>not mp4</html>")]), videoValidator(), output().stream), /video_unavailable/);
  await assert.rejects(pipeline(Readable.from([Buffer.from("short")]), videoValidator(), output().stream), /video_unavailable/);
});
