import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { collectWithInstaloader } from "../instagram-loader/instaloader.js";
import { createPublicNewsService } from "../instagram-loader/public-service.js";

const sample = () => ({ schemaVersion: 1, hashtag: "новости", accountUsername: "antipov__team", scanned: 100, scanLimit: 100, truncated: true, items: [] });
async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "antipov-instaloader-"));
  t.after(async () => {
    assert.equal(path.dirname(directory), tmpdir());
    assert.ok(path.basename(directory).startsWith("antipov-instaloader-"));
    await rm(directory, { recursive: true, force: true });
  });
  return { loaderDataDir: directory, instagramUsername: "antipov__team", instagramHashtag: "новости", instagramScanLimit: 100 };
}

test("Instaloader runs a fixed script without a shell or unrelated integration secrets", async t => {
  const previous = process.env.APIFY_TOKEN;
  process.env.APIFY_TOKEN = "must-not-be-inherited";
  t.after(() => { if (previous === undefined) delete process.env.APIFY_TOKEN; else process.env.APIFY_TOKEN = previous; });
  const config = await setup(t);
  const result = await collectWithInstaloader({ ...config, instagramPython: "trusted-python", instagramSessionFile: "/private/session.json" }, {
    run(executable, args, options, callback) {
      assert.equal(executable, "trusted-python");
      assert.ok(args[0].endsWith("instaloader-news.py"));
      assert.ok(args.includes("antipov__team") && args.includes("/private/session.json"));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.equal(options.env.APIFY_TOKEN, undefined);
      assert.equal(options.timeout, 900000);
      callback(null, JSON.stringify({ ok: true, ...sample() }));
    }
  });
  assert.equal(result.accountUsername, "antipov__team");
});

test("Instaloader process errors are bounded and never expose stderr or credentials", async () => {
  const config = { instagramUsername: "antipov__team", instagramHashtag: "новости" };
  await assert.rejects(collectWithInstaloader(config, { run(_e, _a, _o, done) { done(new Error("session-secret"), '{"ok":false,"error":"instagram_login_required"}', "session-secret"); } }), /^Error: instagram_login_required$/);
  await assert.rejects(collectWithInstaloader(config, { run(_e, _a, _o, done) { done(new Error("session-secret"), '{"ok":false,"error":"session-secret"}'); } }), /^Error: instagram_unavailable$/);
  await assert.rejects(collectWithInstaloader(config, { run(_e, _a, _o, done) { done(Object.assign(new Error("missing"), { code: "ENOENT" }), ""); } }), /instagram_dependency_missing/);
  await assert.rejects(collectWithInstaloader(config, { run(_e, _a, _o, done) { done(null, JSON.stringify({ ok: true, ...sample(), accountUsername: "another-club" })); } }), /instagram_unavailable/);
});

test("public loader collects in the background, coalesces polls and reuses its persisted cache", async t => {
  const config = await setup(t);
  let calls = 0, release;
  const wait = new Promise(resolve => { release = resolve; });
  const service = createPublicNewsService(config, { collect: async () => { calls++; await wait; return sample(); } });
  t.after(() => service.stop());
  assert.equal(service.read().status, 202);
  assert.equal(service.read({ force: true }).status, 202);
  assert.equal(calls, 1);
  release(); await tick();
  const ready = service.read();
  assert.equal(ready.status, 200);
  assert.equal(ready.body.scanned, 100);
  assert.ok(ready.body.generatedAt);
  const restarted = createPublicNewsService(config, { collect: async () => { throw new Error("must not start a new job"); } });
  t.after(() => restarted.stop());
  assert.equal(restarted.read().status, 200);
  assert.equal(service.read({ force: true }).status, 200, "repeat refreshes within a minute reuse the cache");
  assert.equal(calls, 1);
});

test("failed refreshes preserve the file and persist retry backoff instead of returning stale data as fresh", async t => {
  const config = await setup(t);
  let clock = Date.now();
  let fail = false, calls = 0;
  const service = createPublicNewsService(config, { now: () => clock, collect: async () => {
    calls++; if (fail) throw new Error("instagram_rate_limited"); return sample();
  } });
  t.after(() => service.stop());
  assert.equal(service.read().status, 202); await tick();
  const before = await readFile(path.join(config.loaderDataDir, "instaloader-feed.json"), "utf8");
  clock += 61000; fail = true;
  assert.equal(service.read({ force: true }).status, 202); await tick();
  assert.equal(service.read().body.error, "instagram_rate_limited");
  assert.equal(await readFile(path.join(config.loaderDataDir, "instaloader-feed.json"), "utf8"), before);
  const restarted = createPublicNewsService(config, { now: () => clock, collect: async () => { calls++; return sample(); } });
  t.after(() => restarted.stop());
  assert.equal(restarted.read().status, 502);
  assert.equal(calls, 2);
  clock += 3600001;
  assert.equal(restarted.read().status, 202); await tick();
  assert.equal(restarted.read().status, 200);
  assert.equal(calls, 3);
});

test("foreign account results cannot replace a public loader cache", async t => {
  const config = await setup(t);
  const service = createPublicNewsService(config, { collect: async () => ({ ...sample(), accountUsername: "another-club" }) });
  t.after(() => service.stop());
  assert.equal(service.read().status, 202); await tick();
  assert.equal(service.read().body.error, "instagram_unavailable");
  await assert.rejects(readFile(path.join(config.loaderDataDir, "instaloader-feed.json")), { code: "ENOENT" });
});

test("public feed exposes a video identifier without disclosing its signed CDN URL", async t => {
  const config = await setup(t);
  const signedUrl = "https://scontent.cdninstagram.com/clip.mp4?private-signature=test-only";
  const service = createPublicNewsService(config, { collect: async () => ({ ...sample(), items: [{ id: "123", caption: "#новости", timestamp: "2026-11-03T10:00:00Z", image: null, link: "https://www.instagram.com/p/example/", videoUrl: signedUrl }] }) });
  t.after(() => service.stop());
  service.read(); await tick();
  const result = service.read();
  assert.deepEqual(result.body.items[0].video, { id: "123", contentType: "video/mp4" });
  assert.ok(!JSON.stringify(result.body).includes("private-signature"));
  assert.equal(service.videoUrl("123"), signedUrl);
  assert.equal(service.videoUrl("999"), "");
});
