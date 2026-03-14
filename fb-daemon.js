const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core.js');
const RESULTS_DIR = path.join(ROOT, 'scrape-results');

const CYCLE_INTERVAL_MS = 2 * 60 * 1000;
const TAB_TIMEOUT_MS = 30 * 1000;
const CONCURRENCY = 5;
const POST_LIMIT = 3;

const GROUPS = [
  'toolwebapp', 'thietkewebvietnam', '1685891735047297', '362900488947380',
  '606643771643699', '1104882584238051', 'congdongthietkewebsitegiare',
  '1712169349298592', 'hoithietkewebsiteviet', '1998083910206781',
  'n8n.automation', '1953768764898561', 'canhovhgpthuduc',
  '1253003428939928', '843936324120052', '197773610041069', 'chocudanvinhomeq9'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' }); }

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(ROOT, 'daemon.log'), line + '\n');
}

function groupUrl(gid) {
  return `https://www.facebook.com/groups/${gid}/?sorting_setting=CHRONOLOGICAL`;
}

async function scrapeTab(context, groupId, coreScript) {
  const page = await context.newPage();
  try {
    const result = await Promise.race([
      (async () => {
        await page.goto(groupUrl(groupId), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(4000);
        if (await page.locator('input[name="email"]').count()) return { success: false, groupId, error: 'Not logged in' };
        await page.evaluate(coreScript);
        const data = await page.evaluate(async ({ groupId, limit }) => {
          return await window.__fbGroupExtractor({ groupId, limit });
        }, { groupId, limit: POST_LIMIT });
        const posts = data.posts || [];
        return { success: posts.length > 0, groupId, count: posts.length, posts };
      })(),
      sleep(TAB_TIMEOUT_MS).then(() => ({ success: false, groupId, error: 'TIMEOUT', timedOut: true }))
    ]);
    return result;
  } catch (err) {
    return { success: false, groupId, error: err.message };
  } finally {
    try { await page.close(); } catch {}
  }
}

async function runCycle(context, coreScript, cycleNum) {
  log(`━━━ CYCLE #${cycleNum} START ━━━`);
  const results = [];
  const retryQueue = [];

  for (let i = 0; i < GROUPS.length; i += CONCURRENCY) {
    const batch = GROUPS.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(gid => scrapeTab(context, gid, coreScript)));
    for (const r of batchResults) {
      if (r.success) { results.push(r); log(`  ✅ ${r.groupId}: ${r.count} bài`); }
      else { retryQueue.push(r.groupId); log(`  ⚠️ ${r.groupId}: ${r.error || '0 posts'}`); }
    }
    if (i + CONCURRENCY < GROUPS.length) await sleep(1500);
  }

  if (retryQueue.length > 0) {
    log(`  🔄 Retrying ${retryQueue.length} groups...`);
    for (const gid of retryQueue) {
      const r = await scrapeTab(context, gid, coreScript);
      if (r.success) { results.push(r); log(`  ✅ ${gid} (retry): ${r.count} bài`); }
      else { results.push({ success: false, groupId: gid, error: r.error || '0 posts', count: 0, posts: [] }); log(`  ❌ ${gid} (retry): ${r.error || 'still 0'}`); }
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const succeeded = results.filter(r => r.success).length;
  const summary = { cycle: cycleNum, timestamp: now(), total: results.length, succeeded, failed: results.length - succeeded, results };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');
  log(`━━━ CYCLE #${cycleNum} DONE: ${succeeded}/${results.length} groups OK ━━━`);
  return summary;
}

async function main() {
  log('========================================');
  log(`FB Daemon (scrape only) — interval: ${CYCLE_INTERVAL_MS/1000}s`);
  log(`Groups: ${GROUPS.length} | Concurrency: ${CONCURRENCY}`);
  log('========================================');

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1440, height: 1200 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  let cycleNum = 0;

  while (true) {
    cycleNum++;
    try { await runCycle(context, coreScript, cycleNum); } catch (err) { log(`CYCLE #${cycleNum} ERROR: ${err.message}`); }
    const pages = context.pages();
    for (let i = 1; i < pages.length; i++) { try { await pages[i].close(); } catch {} }
    log(`Sleeping ${CYCLE_INTERVAL_MS/1000}s...`);
    await sleep(CYCLE_INTERVAL_MS);
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
