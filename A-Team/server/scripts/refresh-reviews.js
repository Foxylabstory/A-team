import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { ROOT, loadConfig } from '../lib/config.js';
import { collectReviews } from '../lib/apify-reviews.js';
import { normalizeReviews, writeReviewSnapshot } from '../lib/reviews.js';

dotenv.config({path:path.join(ROOT,'.env'),quiet:true});
try {
  const seedIndex=process.argv.indexOf('--from-file');
  const runIndex=process.argv.indexOf('--run-file');
  let snapshot;
  if (seedIndex>=0) {
    const items=JSON.parse(await readFile(process.argv[seedIndex+1],'utf8'));
    const run=JSON.parse(await readFile(process.argv[runIndex+1],'utf8'));
    if (run.status!=='SUCCEEDED') throw new Error('Only a successful source run can be imported.');
    snapshot=normalizeReviews(items,{updatedAt:run.finishedAt});
  } else {
    snapshot=await collectReviews(process.env.APIFY_TOKEN,{log:value=>console.log(JSON.stringify(value))});
  }
  const config=loadConfig();
  writeReviewSnapshot(path.join(config.dataDir,'reviews-cache.json'),snapshot);
  if (seedIndex>=0 || process.argv.includes('--export-static')) {
    for (const directory of [path.join(ROOT,'public/assets'),path.resolve(ROOT,'../../docs/assets'),path.resolve(ROOT,'../../assets')]) {
      writeReviewSnapshot(path.join(directory,'club-reviews.json'),snapshot);
    }
  }
  console.log(`Отзывы обновлены: рейтинг ${snapshot.rating}, отзывов ${snapshot.reviewCount}, опубликовано ${snapshot.reviews.length}.`);
} catch (error) {
  const message=String(error.message || 'Unknown review refresh error.').replaceAll(process.env.APIFY_TOKEN || '\0','[redacted]');
  console.error(message);
  process.exitCode=1;
}
