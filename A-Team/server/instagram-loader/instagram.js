import { IMAGE_LIMIT, imageType, readLimited } from "./images.js";

export function hashtagPattern(tag) {
  return new RegExp(`(?<![\\p{L}\\p{N}_])#${tag}(?![\\p{L}\\p{N}_])`, "giu");
}

export async function collectInstagram(config, fetchImpl = fetch) {
  if (!/^\d+$/.test(config.instagramUser || "") || !config.instagramToken) throw new Error("instagram_not_configured");
  const signal = AbortSignal.timeout(45000);
  const host = config.instagramLogin === "instagram" ? "graph.instagram.com" : "graph.facebook.com";
  const base = `https://${host}/${config.instagramVersion}/${config.instagramUser}/media`;
  const graph = async url => {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.instagramToken}` }, signal, redirect: "error" });
    if ([401, 403].includes(response.status)) throw new Error("instagram_auth");
    const payload = JSON.parse((await readLimited({ ok: true, headers: response.headers, body: response.body }, 1024 * 1024)).toString("utf8"));
    if (payload.error) throw new Error(payload.error.code === 190 ? "instagram_auth" : "instagram_response");
    if (!response.ok) throw new Error("instagram_response");
    return payload;
  };
  let accountUsername = "";
  if (config.instagramUsername) {
    const accountUrl = new URL(`https://${host}/${config.instagramVersion}/${config.instagramUser}`);
    accountUrl.searchParams.set("fields", "id,username");
    const account = await graph(accountUrl);
    if (String(account.id) !== config.instagramUser || typeof account.username !== "string" || account.username.toLowerCase() !== config.instagramUsername) {
      throw new Error("instagram_account_mismatch");
    }
    accountUsername = account.username.toLowerCase();
  }
  const collected = new Map();
  let after;
  const cursors = new Set();
  let truncated = false;
  let scanned = 0;
  for (let page = 0; page < 10; page++) {
    const url = new URL(base);
    url.search = new URLSearchParams({ fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp", limit: "50", ...(after ? { after } : {}) });
    const payload = await graph(url);
    if (!Array.isArray(payload.data) || payload.data.length > 50) throw new Error("instagram_response");
    scanned += payload.data.length;
    for (const media of payload.data) {
      const caption = String(media.caption || "").normalize("NFKC");
      if (hashtagPattern(config.instagramHashtag).test(caption) && /^\d+$/.test(media.id || "")) collected.set(media.id, media);
    }
    const next = payload.paging?.cursors?.after;
    if (!payload.paging?.next || !next || cursors.has(next)) break;
    cursors.add(next);
    after = next;
    if (page === 9) truncated = true;
  }
  const selected = [...collected.values()].filter(m => Number.isFinite(Date.parse(m.timestamp)))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, 6);
  const items = [];
  for (const media of selected) {
    let image = null;
    const address = media.media_type === "VIDEO" ? media.thumbnail_url : media.media_url;
    if (address) {
      const url = new URL(address);
      const allowed = ["cdninstagram.com", "fbcdn.net"].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
      if (!allowed || url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) throw new Error("instagram_image_host");
      const response = await fetchImpl(url, { signal, redirect: "error" });
      const bytes = await readLimited(response, IMAGE_LIMIT);
      const { type } = imageType(bytes);
      image = { type, data: bytes.toString("base64") };
    }
    items.push({ id: media.id, caption: String(media.caption || ""), timestamp: media.timestamp, link: media.permalink || "", image });
  }
  return { schemaVersion: 1, hashtag: config.instagramHashtag, accountUsername, items, truncated, scanned };
}
