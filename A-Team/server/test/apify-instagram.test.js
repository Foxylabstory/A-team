import assert from "node:assert/strict";
import test from "node:test";
import { collectWithApify } from "../instagram-loader/apify.js";

const config = { apifyToken: "test-token", instagramUsername: "antipov__team", instagramHashtag: "новости" };
const cover = "https://scontent.cdninstagram.com/cover.png";
const video = "https://scontent.cdninstagram.com/reel.mp4";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function post(id, fields = {}) {
  const shortCode = "ABCDEFGH"[id];
  return { id: String(id), shortCode, type: "post", status: "SUCCESS", mediaType: "IMAGE", owner: { username: config.instagramUsername },
    caption: "Выступили на турнире. #новости", timestamp: `2026-11-${String(id).padStart(2, "0")}T12:00:00Z`,
    url: `https://www.instagram.com/p/${shortCode}/`, media: { displayUrl: cover }, ...fields };
}

function accountUsage(monthlyUsageUsd) {
  return {
    "/v2/users/me": { data: { plan: { tier: "FREE", monthlyBasePriceUsd: 0, monthlyUsageCreditsUsd: 5 } } },
    "/v2/users/me/limits": { data: { current: { monthlyUsageUsd } } }
  };
}

test("Apify imports the three newest tagged club posts and preserves carousel video", async () => {
  const usage = accountUsage(1);
  const since = "2026-11-01T12:00:00.000Z";
  let runs = 0;
  const rows = [post(1), post(2), post(3), post(4), post(5, { id: "4025922453682794000", shortCode: "Dfe8yQxCC2Q",
    owner: { username: "coach" }, mediaType: "CAROUSEL", coauthors: [{ username: config.instagramUsername }],
    childPosts: [{ type: "IMAGE" }, { type: "VIDEO", videoUrl: video }] }),
  post(6, { owner: { username: "another_club" } }), post(7, { caption: "#новостиспорт" })];
  const feed = await collectWithApify(config, { since, async fetchImpl(address, options) {
    const url = new URL(address);
    if (url.href === cover) {
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      return new Response(png);
    }
    assert.equal(url.hostname, "api.apify.com");
    assert.equal(options.headers.Authorization, `Bearer ${config.apifyToken}`);
    assert.equal(url.searchParams.has("token"), false);
    if (usage[url.pathname]) return Response.json(usage[url.pathname]);
    assert.equal(url.pathname, "/v2/acts/coregent~instagram-posts-scraper/run-sync-get-dataset-items");
    assert.equal(url.searchParams.get("maxTotalChargeUsd"), "0.06");
    assert.equal(url.searchParams.get("restartOnError"), "false");
    assert.equal(options.method, "POST");
    const input = JSON.parse(options.body);
    assert.deepEqual(input.profiles, [config.instagramUsername]);
    assert.equal(input.postsNewerThan, "2026-11-01T12:00:00.001Z");
    runs++;
    return Response.json(rows);
  } });
  assert.equal(runs, 1);
  assert.deepEqual(feed.items.map(item => item.id), ["4025922453682793872", "4", "3"]);
  assert.equal(feed.latestPostAt, "2026-11-07T12:00:00.000Z");
  assert.equal(feed.items[0].image.data, png.toString("base64"));
  assert.equal(feed.items[0].videoUrl, video);
});

test("Apify accepts a successful empty batch without moving the cursor", async () => {
  const usage = accountUsage(1);
  const since = "2026-11-08T14:16:17.000Z";
  const result = await collectWithApify(config, { since, async fetchImpl(address) {
    return Response.json(usage[new URL(address).pathname] ?? []);
  } });
  assert.deepEqual(result.items, []);
  assert.equal(result.scanned, 0);
  assert.equal(result.latestPostAt, since);
});

test("Apify collection leaves enough Free credits for reviews before starting an actor", async t => {
  const usage = accountUsage(4.85);
  t.mock.method(console, "warn", () => {});
  await assert.rejects(collectWithApify(config, { async fetchImpl(address, options) {
    assert.notEqual(options.method, "POST");
    return Response.json(usage[new URL(address).pathname]);
  } }), /instagram_unavailable/);
});
