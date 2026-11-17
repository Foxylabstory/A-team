import { readLimited } from "./images.js";
import { hashtagPattern, INSTAGRAM_NEWS_LIMIT, readInstagramImage } from "./instagram.js";

const SCAN_LIMIT = 20;
const RUN_CHARGE = 0.06;
const REVIEWS_RESERVE = 0.12;

export async function collectWithApify(config, { fetchImpl = fetch, signal, since = "" } = {}) {
  async function api(endpoint, options = {}) {
    const deadline = AbortSignal.timeout(100000);
    const response = await fetchImpl(`https://api.apify.com/v2/${endpoint}`, {
      ...options, headers: { Authorization: `Bearer ${config.apifyToken}`, "Content-Type": "application/json" },
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: "error"
    });
    return JSON.parse((await readLimited(response, 4 * 1024 * 1024)).toString("utf8"));
  }

  const [{ data: account }, { data: limits }] = await Promise.all([api("users/me"), api("users/me/limits")]);
  const remaining = account?.plan?.monthlyUsageCreditsUsd - limits?.current?.monthlyUsageUsd;
  if (account?.plan?.tier !== "FREE" || account.plan.monthlyBasePriceUsd !== 0 || !(remaining >= RUN_CHARGE + REVIEWS_RESERVE)) {
    console.warn("Instagram: Apify Free credits are unavailable or reserved for the reviews import.");
    throw new Error("instagram_unavailable");
  }

  const query = new URLSearchParams({ maxTotalChargeUsd: String(RUN_CHARGE), timeout: "85", restartOnError: "false", clean: "true",
    forcePermissionLevel: "LIMITED_PERMISSIONS", fields: "id,caption,timestamp,url,type,displayUrl,videoUrl,childPosts,ownerUsername,coauthorProducers,error" });
  const cutoff = Date.parse(since) || 0;
  // Apify includes posts at the exact input timestamp.
  const dateFilter = cutoff ? { onlyPostsNewerThan: new Date(cutoff + 1).toISOString() } : {};
  // Do not retry a charged run. A lost response does not mean the run did not start.
  const rows = await api(`acts/apify~instagram-post-scraper/run-sync-get-dataset-items?${query}`, {
    method: "POST", body: JSON.stringify({ username: [config.instagramUsername], resultsLimit: SCAN_LIMIT,
      skipPinnedPosts: true, dataDetailLevel: "detailedData", ...dateFilter })
  });
  if (!Array.isArray(rows) || rows.length > SCAN_LIMIT || rows.some(row => !row || row.error)) throw new Error("instagram_unavailable");

  let foundAccount = false;
  let latestPost = cutoff;
  const selected = new Map();
  for (const row of rows) {
    const matchesAccount = row.ownerUsername?.toLowerCase() === config.instagramUsername ||
      (Array.isArray(row.coauthorProducers) && row.coauthorProducers.some(account => account?.username?.toLowerCase() === config.instagramUsername));
    if (!matchesAccount) continue;
    foundAccount = true;
    const publishedAt = Date.parse(row.timestamp);
    if (!/^\d{1,40}$/.test(row.id || "") || !(publishedAt > cutoff)) continue;
    latestPost = Math.max(latestPost, publishedAt);
    if (typeof row.caption !== "string" || !hashtagPattern(config.instagramHashtag).test(row.caption.normalize("NFKC"))) continue;
    selected.set(row.id, row);
  }
  if (rows.length && !foundAccount) throw new Error("instagram_account_mismatch");
  const latest = [...selected.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, INSTAGRAM_NEWS_LIMIT);
  const deadline = AbortSignal.timeout(20000);
  const imageSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const items = await Promise.all(latest.map(async row => {
    const children = Array.isArray(row.childPosts) ? row.childPosts : [];
    const video = row.type === "Video" ? row : children.find(child => child?.type === "Video");
    return { id: row.id, caption: row.caption, timestamp: row.timestamp, link: row.url || "",
      image: await readInstagramImage(row.displayUrl, { fetchImpl, signal: imageSignal }),
      videoUrl: video?.videoUrl, videoUnavailable: !!video && !video.videoUrl };
  }));
  return { schemaVersion: 1, accountUsername: config.instagramUsername, hashtag: config.instagramHashtag,
    latestPostAt: latestPost ? new Date(latestPost).toISOString() : undefined,
    items, scanned: rows.length, scanLimit: SCAN_LIMIT, truncated: rows.length === SCAN_LIMIT && items.length < INSTAGRAM_NEWS_LIMIT };
}
