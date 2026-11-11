import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const CLUB_PLACE_ID = '70000001096882624';
export const CLUB_CARD_URL = `https://2gis.ru/nabchelny/firm/${CLUB_PLACE_ID}`;
export const REVIEWS_URL = `${CLUB_CARD_URL}/tab/reviews`;

function iso(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Invalid review date.');
  return new Date(time).toISOString();
}
function reviewLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === '2gis.ru' && !url.username && !url.password && !url.search) return url.href;
  } catch {}
  return REVIEWS_URL;
}
export function normalizeReviews(items, { updatedAt = new Date().toISOString() } = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new Error('Invalid or oversized review dataset.');
  if (items.some(item => String(item.placeId) !== CLUB_PLACE_ID)) throw new Error('Reviews belong to a different place.');
  if (new Set(items.map(item=>String(item.reviewId))).size !== items.length) throw new Error('Duplicate review records.');
  const first = items[0];
  const reviewCount = first.placeReviewsMeta?.branchReviewCount ?? first.placeReviewCount;
  const rating = first.placeReviewsMeta?.branchRating ?? first.placeRating;
  if (!Number.isInteger(reviewCount) || reviewCount !== items.length) throw new Error('Review dataset is incomplete. Previous reviews are retained.');
  if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 0 || rating > 5) throw new Error('Missing place rating.');
  const unique = new Map();
  for (const item of items) {
    if (String(item.source || item.provider || '').toLowerCase() !== '2gis' || item.isHidden || item.isUnratedPermanently || item.isRated !== true || item.rating !== 5) continue;
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 20000) continue;
    const createdAt = iso(item.dateCreated);
    const name = typeof item.authorName === 'string' && /[\p{L}\p{N}]/u.test(item.authorName) ? item.authorName.trim().slice(0,100) : 'Посетитель клуба';
    const id = String(item.reviewId || '');
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Missing review ID.');
    unique.set(id, { id, name, text:item.text.trim(), rating:5, createdAt, editedAt:item.dateEdited ? iso(item.dateEdited) : null, url:reviewLink(item.reviewUrl) });
  }
  const reviews = [...unique.values()].sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt) || b.id.localeCompare(a.id)).slice(0,3);
  if (!reviews.length) throw new Error('No visible five-star reviews were returned.');
  return validateReviewSnapshot({ schemaVersion:1, placeId:CLUB_PLACE_ID, source:'2gis', cardUrl:CLUB_CARD_URL, reviewsUrl:REVIEWS_URL, rating, reviewCount, updatedAt:iso(updatedAt), reviews });
}

export function validateReviewSnapshot(value) {
  if (!value || value.schemaVersion !== 1 || value.placeId !== CLUB_PLACE_ID || value.source !== '2gis' ||
      typeof value.rating !== 'number' || !Number.isFinite(value.rating) || value.rating < 0 || value.rating > 5 ||
      !Number.isInteger(value.reviewCount) || value.reviewCount < 1 || !Array.isArray(value.reviews) || !value.reviews.length || value.reviews.length > 3 || value.reviewCount < value.reviews.length) throw new Error('Invalid review snapshot.');
  const updatedAt = iso(value.updatedAt);
  if (Date.parse(updatedAt) > Date.now()+86400000) throw new Error('Review snapshot date is in the future.');
  const reviews = value.reviews.map(review => {
    if (!review || typeof review.id !== 'string' || !/^[\w-]{1,100}$/.test(review.id) || review.rating !== 5 ||
        typeof review.name !== 'string' || !review.name.trim() || review.name.length > 100 ||
        typeof review.text !== 'string' || !review.text.trim() || review.text.length > 20000) throw new Error('Invalid public review.');
    return { id:review.id, name:review.name, text:review.text, rating:5, createdAt:iso(review.createdAt), editedAt:review.editedAt ? iso(review.editedAt) : null, url:reviewLink(review.url) };
  });
  if (new Set(reviews.map(r=>r.id)).size !== reviews.length) throw new Error('Duplicate reviews.');
  return { schemaVersion:1, placeId:CLUB_PLACE_ID, source:'2gis', cardUrl:CLUB_CARD_URL, reviewsUrl:REVIEWS_URL,
    rating:value.rating, reviewCount:value.reviewCount, updatedAt, reviews };
}

export function writeReviewSnapshot(filename, value) {
  const snapshot = validateReviewSnapshot(value);
  mkdirSync(path.dirname(filename), { recursive:true });
  const temporary = filename + '.tmp';
  writeFileSync(temporary, JSON.stringify(snapshot,null,2)+'\n', { mode:0o600 });
  renameSync(temporary,filename);
}

function readSnapshot(filename) {
  try { return validateReviewSnapshot(JSON.parse(readFileSync(filename,'utf8'))); } catch { return null; }
}
export function createReviewsUpdater(config, { fetchImpl = fetch, collectImpl } = {}) {
  const filename = path.join(config.dataDir,'reviews-cache.json');
  const stateFilename = path.join(config.dataDir,'reviews-update-state.json');
  const seed = readSnapshot(path.join(config.publicDir,'assets/club-reviews.json'));
  const cached = readSnapshot(filename);
  let snapshot = cached && (!seed || Date.parse(cached.updatedAt)>=Date.parse(seed.updatedAt)) ? cached : seed;
  let interval, inFlight;
  let lastAttempt = 0;
  try { lastAttempt=Number(JSON.parse(readFileSync(stateFilename,'utf8')).lastAttempt) || 0; } catch {}
  const configured=!!config.apifyToken && config.reviewsAutoUpdate !== false;
  const day=86400000;
  function current() {
    const disk=readSnapshot(filename);
    if (disk && (!snapshot || Date.parse(disk.updatedAt)>Date.parse(snapshot.updatedAt))) snapshot=disk;
    return snapshot;
  }
  async function refresh() {
    current();
    if (!configured) return snapshot;
    if (inFlight) return inFlight;
    if (Date.now()-Math.max(lastAttempt, snapshot ? Date.parse(snapshot.updatedAt) : 0)<day) return snapshot;
    // Persist an attempt before starting Apify so restarts cannot create duplicate charged runs.
    lastAttempt=Date.now();
    mkdirSync(config.dataDir,{recursive:true});
    writeFileSync(stateFilename+'.tmp',JSON.stringify({lastAttempt})+'\n',{mode:0o600});
    renameSync(stateFilename+'.tmp',stateFilename);
    inFlight = (async () => {
      const collect=collectImpl || (async()=>{
        const {collectReviews}=await import('./apify-reviews.js');
        return collectReviews(config.apifyToken,{fetchImpl});
      });
      const next = validateReviewSnapshot(await collect());
      if (snapshot && Date.parse(next.updatedAt)<=Date.parse(snapshot.updatedAt)) return snapshot;
      writeReviewSnapshot(filename,next);
      snapshot=next;
      return snapshot;
    })().finally(()=>{ inFlight=undefined; });
    return inFlight;
  }
  return { get:current, refresh, configured,
    start() {
      if (interval || !configured) return;
      const update = () => refresh().catch(()=>console.warn('Отзывы: источник недоступен, сохранены предыдущие данные.'));
      void update();
      interval=setInterval(update,3600000); interval.unref();
    },
    async stop() { clearInterval(interval); interval=undefined; await inFlight?.catch(()=>{}); }
  };
}
