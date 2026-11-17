import { readLimited } from "./images.js";
import { hashtagPattern, INSTAGRAM_NEWS_LIMIT, readInstagramImage } from "./instagram.js";

const SCAN_LIMIT = 12;
const RUN_CHARGE = 0.06;
const REVIEWS_RESERVE = 0.12;
const SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function postId(shortCode) {
  if (typeof shortCode !== "string" || !/^[\w-]{1,20}$/.test(shortCode)) return "";
  // Some actor responses contain a rounded numeric ID. The shortcode preserves every bit.
  let id = 0n;
  for (const character of shortCode) id = id * 64n + BigInt(SHORTCODE_ALPHABET.indexOf(character));
  return id.toString();
}

export async function collectWithApify(config, { fetchImpl = fetch, signal, since = "" } = {}) {
  async function api(endpoint, options = {}) {
    const deadline = AbortSignal.timeout(130000);
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

  const query = new URLSearchParams({ maxTotalChargeUsd: String(RUN_CHARGE), timeout: "115", restartOnError: "false", clean: "true",
    forcePermissionLevel: "LIMITED_PERMISSIONS", fields: "type,status,shortCode,caption,timestamp,url,mediaType,media,childPosts,owner,coauthors" });
  const cutoff = Date.parse(since) || 0;
  const dateFilter = cutoff ? { postsNewerThan: new Date(cutoff + 1).toISOString() } : {};
  // Do not retry a charged run. A lost response does not mean the run did not start.
  const rows = await api(`acts/coregent~instagram-posts-scraper/run-sync-get-dataset-items?${query}`, {
    method: "POST", body: JSON.stringify({ profiles: [config.instagramUsername], resultsLimit: SCAN_LIMIT,
      includeOwnerDetails: false, ...dateFilter })
  });
  if (!Array.isArray(rows) || rows.length > SCAN_LIMIT || rows.some(row => row?.type !== "post" || row.status !== "SUCCESS")) throw new Error("instagram_unavailable");

  let foundAccount = false;
  let latestPost = cutoff;
  const selected = new Map();
  for (const row of rows) {
    const matchesAccount = row.owner?.username?.toLowerCase() === config.instagramUsername ||
      (Array.isArray(row.coauthors) && row.coauthors.some(account => account?.username?.toLowerCase() === config.instagramUsername));
    if (!matchesAccount) continue;
    foundAccount = true;
    const publishedAt = Date.parse(row.timestamp);
    const id = postId(row.shortCode);
    if (!id || !(publishedAt > cutoff)) continue;
    latestPost = Math.max(latestPost, publishedAt);
    if (typeof row.caption !== "string" || !hashtagPattern(config.instagramHashtag).test(row.caption.normalize("NFKC"))) continue;
    selected.set(id, { ...row, id });
  }
  if (rows.length && !foundAccount) throw new Error("instagram_account_mismatch");
  const latest = [...selected.values()].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, INSTAGRAM_NEWS_LIMIT);
  const deadline = AbortSignal.timeout(20000);
  const imageSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const items = await Promise.all(latest.map(async row => {
    const children = Array.isArray(row.childPosts) ? row.childPosts : [];
    const isVideo = row.mediaType === "VIDEO" || row.mediaType === "REEL";
    const videoUrl = isVideo ? row.media?.videoUrl : children.find(child => child?.type === "VIDEO" && child.videoUrl)?.videoUrl;
    return { id: row.id, caption: row.caption, timestamp: row.timestamp, link: row.url || "",
      image: await readInstagramImage(row.media?.thumbnailUrl || row.media?.displayUrl, { fetchImpl, signal: imageSignal }),
      videoUrl, videoUnavailable: !videoUrl && (isVideo || children.some(child => child?.type === "VIDEO")) };
  }));
  return { schemaVersion: 1, accountUsername: config.instagramUsername, hashtag: config.instagramHashtag,
    latestPostAt: latestPost ? new Date(latestPost).toISOString() : undefined,
    items, scanned: rows.length, scanLimit: SCAN_LIMIT, truncated: rows.length === SCAN_LIMIT && items.length < INSTAGRAM_NEWS_LIMIT };
}
