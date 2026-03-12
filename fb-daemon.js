const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core.js');
const RESULTS_DIR = path.join(ROOT, 'scrape-results');
const STATE_FILE = path.join(ROOT, '.pw-facebook-storage.json');

// Config
const CYCLE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TAB_TIMEOUT_MS = 30 * 1000; // 30s max per tab before killing
const CONCURRENCY = 5; // tabs open at same time
const POST_LIMIT = 3;

// All 17 groups
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

function groupUrl(groupId) {
  return `https://www.facebook.com/groups/${groupId}/?sorting_setting=CHRONOLOGICAL`;
}

async function scrapeTab(context, groupId, coreScript) {
  const page = await context.newPage();
  const url = groupUrl(groupId);
  
  try {
    // Race: extraction vs timeout
    const result = await Promise.race([
      (async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(4000);
        
        // Check login
        const loginForm = await page.locator('input[name="email"]').count();
        if (loginForm) return { success: false, groupId, error: 'Not logged in' };
        
        // Inject & extract
        await page.evaluate(coreScript);
        const data = await page.evaluate(async ({ groupId, limit }) => {
          return await window.__fbGroupExtractor({ groupId, limit });
        }, { groupId, limit: POST_LIMIT });
        
        const posts = data.posts || [];
        return { success: posts.length > 0, groupId, count: posts.length, posts };
      })(),
      // Timeout guard — kill tab if stuck
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
  
  // Process in batches
  for (let i = 0; i < GROUPS.length; i += CONCURRENCY) {
    const batch = GROUPS.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(gid => scrapeTab(context, gid, coreScript))
    );
    
    for (const r of batchResults) {
      if (r.success) {
        results.push(r);
        log(`  ✅ ${r.groupId}: ${r.count} bài`);
      } else if (r.timedOut) {
        // Tab timed out — add to retry once, don't wait forever
        retryQueue.push(r.groupId);
        log(`  ⏱️ ${r.groupId}: TIMEOUT — will retry`);
      } else if (r.error === 'Not logged in') {
        log(`  ❌ ${r.groupId}: NOT LOGGED IN`);
        results.push(r);
      } else {
        // Got 0 posts — might need scroll, retry once
        retryQueue.push(r.groupId);
        log(`  ⚠️ ${r.groupId}: 0 posts — will retry`);
      }
    }
    
    if (i + CONCURRENCY < GROUPS.length) await sleep(1500);
  }
  
  // Retry failed ones (one at a time, with more wait)
  if (retryQueue.length > 0) {
    log(`  🔄 Retrying ${retryQueue.length} groups...`);
    for (const gid of retryQueue) {
      const page = await context.newPage();
      try {
        await page.goto(groupUrl(gid), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(6000); // Extra wait for slow groups
        
        await page.evaluate(coreScript);
        const data = await page.evaluate(async ({ groupId, limit }) => {
          return await window.__fbGroupExtractor({ groupId, limit });
        }, { groupId: gid, limit: POST_LIMIT });
        
        const posts = data.posts || [];
        if (posts.length > 0) {
          results.push({ success: true, groupId: gid, count: posts.length, posts });
          log(`  ✅ ${gid} (retry): ${posts.length} bài`);
        } else {
          results.push({ success: false, groupId: gid, error: '0 posts after retry', count: 0, posts: [] });
          log(`  ❌ ${gid} (retry): still 0 posts`);
        }
      } catch (err) {
        results.push({ success: false, groupId: gid, error: err.message });
        log(`  ❌ ${gid} (retry): ${err.message}`);
      } finally {
        try { await page.close(); } catch {}
      }
    }
  }
  
  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(RESULTS_DIR, `cycle-${cycleNum}-${ts}.json`);
  const succeeded = results.filter(r => r.success).length;
  const summary = {
    cycle: cycleNum,
    timestamp: now(),
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results
  };
  fs.writeFileSync(outFile, JSON.stringify(summary, null, 2), 'utf8');
  
  // Also save latest
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');
  
  log(`━━━ CYCLE #${cycleNum} DONE: ${succeeded}/${results.length} groups OK ━━━`);
  return summary;
}

async function main() {
  const intervalMs = Number(process.argv[2] || CYCLE_INTERVAL_MS);
  
  log('========================================');
  log(`FB Group Daemon starting — interval: ${intervalMs/1000}s`);
  log(`Groups: ${GROUPS.length} | Concurrency: ${CONCURRENCY} | Tab timeout: ${TAB_TIMEOUT_MS/1000}s`);
  log('========================================');
  
  // Launch persistent browser — NEVER close it
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 1200 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  
  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  let cycleNum = 0;
  
  // Run first cycle immediately
  while (true) {
    cycleNum++;
    try {
      await runCycle(context, coreScript, cycleNum);
    } catch (err) {
      log(`CYCLE #${cycleNum} ERROR: ${err.message}`);
    }
    
    // Close any stale pages (keep only 1 blank tab)
    const pages = context.pages();
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close(); } catch {}
    }
    
    log(`Sleeping ${intervalMs/1000}s until next cycle...`);
    await sleep(intervalMs);
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
