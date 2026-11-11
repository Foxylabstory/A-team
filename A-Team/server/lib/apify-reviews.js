import { normalizeReviews, CLUB_CARD_URL } from './reviews.js';

const ACTOR = 'zen-studio~2gis-reviews-scraper';
export async function collectReviews(token, { fetchImpl=fetch, log=()=>{} } = {}) {
  if (typeof token!=='string' || !token.trim() || /\s/.test(token)) throw new Error('APIFY_TOKEN is missing or invalid.');
  async function api(endpoint, options={}) {
    const response=await fetchImpl(`https://api.apify.com/v2/${endpoint}`,{...options,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(35000),redirect:'error'});
    if (!response.ok) throw new Error(`Apify request failed: HTTP ${response.status}.`);
    const data=await response.json();
    return data.data===undefined ? data : data.data;
  }
  const [account,limits]=await Promise.all([api('users/me'),api('users/me/limits')]);
  if (account.plan?.tier!=='FREE' || account.plan.monthlyBasePriceUsd!==0) throw new Error('Automatic review collection is restricted to the Free plan.');
  if (account.plan.monthlyUsageCreditsUsd-limits.current.monthlyUsageUsd<0.12) throw new Error('Insufficient free Apify credits. Previous reviews are retained.');
  const input={startUrls:[CLUB_CARD_URL],maxPlaces:1,maxReviews:100,language:'ru',reviewsRating:'all',reviewsSource:'all'};
  // Never retry this POST: a lost response must not create a second charged run.
  let run=await api(`acts/${ACTOR}/runs?maxTotalChargeUsd=0.12&timeout=180&memory=512&restartOnError=false`,{method:'POST',body:JSON.stringify(input)});
  log({runId:run.id,status:run.status});
  for (let attempt=0; !['SUCCEEDED','FAILED','TIMED-OUT','ABORTED'].includes(run.status) && attempt<12; attempt++) {
    run=await api(`actor-runs/${encodeURIComponent(run.id)}?waitForFinish=20`);
  }
  if (run.status!=='SUCCEEDED') throw new Error(`Apify run did not succeed (${run.status}, ${run.id}). Previous reviews are retained.`);
  const items=await api(`datasets/${encodeURIComponent(run.defaultDatasetId)}/items?format=json&clean=true&limit=101`);
  const snapshot=normalizeReviews(items,{updatedAt:run.finishedAt});
  log({runId:run.id,status:run.status,reviewCount:snapshot.reviewCount,usageTotalUsd:run.usageTotalUsd});
  return snapshot;
}
