import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { normalizeReviews, validateReviewSnapshot, writeReviewSnapshot, createReviewsUpdater, CLUB_PLACE_ID } from '../lib/reviews.js';
import { collectReviews } from '../lib/apify-reviews.js';

const day=86400000;
function dataset() {
  const row=(id,date,patch={})=>({placeId:CLUB_PLACE_ID,placeRating:4.8,reviewId:id,rating:5,isRated:true,isHidden:false,provider:'2gis',source:null,authorName:'Автор '+id,text:'Текст '+id,dateCreated:date,...patch});
  const rows=[row('old','2025-01-01',{dateEdited:'2026-10-01'}),row('newest','2026-01-03'),row('middle','2026-01-02'),row('third','2026-01-01',{authorName:'. .'}),
    row('hidden','2026-02-01',{isHidden:true}),row('four','2026-02-01',{rating:4}),row('other','2026-02-02',{provider:'flamp'})];
  return rows.map(r=>({...r,placeReviewCount:rows.length}));
}
const snapshot=(age=0)=>normalizeReviews(dataset(),{updatedAt:new Date(Date.now()-age).toISOString()});
async function files(t) {
  const directory=await mkdtemp(path.join(os.tmpdir(),'antipov-reviews-'));
  t.after(async()=>{
    assert.equal(path.dirname(directory),os.tmpdir());
    assert.ok(path.basename(directory).startsWith('antipov-reviews-'));
    await rm(directory,{recursive:true,force:true});
  });
  return {dataDir:path.join(directory,'data'),publicDir:path.join(directory,'public'),apifyToken:'test-only-apify-token',reviewsAutoUpdate:true};
}

test('review selection uses creation dates, ignores pins/edits, and preserves the overall place rating',()=>{
  const result=snapshot();
  assert.deepEqual(result.reviews.map(r=>r.id),['newest','middle','third']);
  assert.equal(result.rating,4.8);
  assert.equal(result.reviewCount,7);
  assert.equal(result.reviews[2].name,'Посетитель клуба');
  assert.ok(result.reviews.every(r=>r.url.endsWith('/tab/reviews')));
  assert.ok(!JSON.stringify(result).includes('authorUserId'));
});
test('partial, duplicate, foreign and malformed review datasets do not replace a valid snapshot',()=>{
  const rows=dataset();
  assert.throws(()=>normalizeReviews(rows.slice(0,3)),/incomplete/);
  assert.throws(()=>normalizeReviews([...rows.slice(0,-1),rows[0]]),/Duplicate/);
  assert.throws(()=>normalizeReviews(rows.map(r=>({...r,placeId:'another-club'}))),/different place/);
  assert.throws(()=>normalizeReviews(rows.map(r=>({...r,placeRating:NaN}))),/rating/);
  assert.throws(()=>validateReviewSnapshot({...snapshot(),reviewCount:1}));
});
test('reviews are collected once per day, coalesced in flight, and not collected again after a restart',async t=>{
  const config=await files(t);
  writeReviewSnapshot(path.join(config.publicDir,'assets/club-reviews.json'),snapshot(2*day));
  let calls=0, release;
  const wait=new Promise(resolve=>{release=resolve;});
  const service=createReviewsUpdater(config,{collectImpl:async()=>{calls++;await wait;return snapshot();}});
  const first=service.refresh(),second=service.refresh();
  assert.equal(calls,1);
  release();
  const [a,b]=await Promise.all([first,second]);
  assert.deepEqual(a,b);
  await service.refresh();
  assert.equal(calls,1);
  await service.stop();
  const restarted=createReviewsUpdater(config,{collectImpl:async()=>{calls++;return snapshot();}});
  await restarted.refresh();
  assert.equal(calls,1);
  assert.deepEqual(restarted.get(),a);
  await restarted.stop();
});
test('a failed collection retains cached reviews and its daily attempt limit survives a restart',async t=>{
  const config=await files(t);
  const previous=snapshot(2*day);
  const cache=path.join(config.dataDir,'reviews-cache.json');
  writeReviewSnapshot(cache,previous);
  const original=await readFile(cache,'utf8');
  let calls=0;
  const fail=async()=>{calls++;throw new Error('Source is down');};
  const service=createReviewsUpdater(config,{collectImpl:fail});
  await assert.rejects(service.refresh(),/Source is down/);
  assert.deepEqual(service.get(),previous);
  assert.equal(await readFile(cache,'utf8'),original);
  await service.stop();
  const restarted=createReviewsUpdater(config,{collectImpl:fail});
  await restarted.refresh();
  assert.equal(calls,1);
  assert.deepEqual(restarted.get(),previous);
  await restarted.stop();
});
test('fresh cache and disabled collection never start an Apify run',async t=>{
  const config=await files(t);
  writeReviewSnapshot(path.join(config.dataDir,'reviews-cache.json'),snapshot());
  let calls=0;
  const service=createReviewsUpdater(config,{collectImpl:async()=>{calls++;throw new Error('must not run');}});
  await service.refresh();
  service.start();
  await service.stop();
  const disabled=createReviewsUpdater({...config,reviewsAutoUpdate:false},{collectImpl:async()=>{calls++;}});
  await disabled.refresh();
  assert.equal(calls,0);
  await disabled.stop();
});
test('Apify collection enforces Free credits, a per-run cap and a complete dataset without exposing account data',async()=>{
  let posts=0;
  const fake=async(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer test-only-token');
    const endpoint=new URL(url);
    let data;
    if(endpoint.pathname.endsWith('/users/me')) data={plan:{tier:'FREE',monthlyBasePriceUsd:0,monthlyUsageCreditsUsd:5},proxy:{password:'private-proxy-secret'}};
    else if(endpoint.pathname.endsWith('/users/me/limits')) data={current:{monthlyUsageUsd:0}};
    else if(options.method==='POST') {
      posts++;
      assert.equal(endpoint.searchParams.get('maxTotalChargeUsd'),'0.12');
      assert.equal(endpoint.searchParams.get('restartOnError'),'false');
      assert.equal(JSON.parse(options.body).maxReviews,100);
      data={id:'run',status:'RUNNING'};
    } else if(endpoint.pathname.includes('/actor-runs/')) data={id:'run',status:'SUCCEEDED',defaultDatasetId:'dataset',finishedAt:new Date().toISOString(),usageTotalUsd:0.014};
    else if(endpoint.pathname.includes('/datasets/')) return new Response(JSON.stringify(dataset()));
    else throw new Error('Unexpected endpoint');
    return new Response(JSON.stringify({data}));
  };
  const result=await collectReviews('test-only-token',{fetchImpl:fake});
  assert.equal(posts,1);
  assert.equal(result.reviews.length,3);
  assert.ok(!JSON.stringify(result).includes('private-proxy-secret'));
  assert.ok(!JSON.stringify(result).includes('test-only-token'));
  let writes=0;
  await assert.rejects(collectReviews('token',{fetchImpl:async(url,options)=>{
    if(options.method==='POST') writes++;
    return new Response(JSON.stringify({data:url.endsWith('/users/me') ? {plan:{tier:'BRONZE',monthlyBasePriceUsd:19,monthlyUsageCreditsUsd:19}} : {current:{monthlyUsageUsd:0}}}));
  }}),/Free plan/);
  assert.equal(writes,0);
});
