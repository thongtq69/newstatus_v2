const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const readline = require('readline');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core.js');
const RESULTS_DIR = path.join(ROOT, 'scrape-results');

const CYCLE_INTERVAL_MS = 2 * 60 * 1000;
const TAB_TIMEOUT_MS = 30 * 1000;
const CONCURRENCY = 5;
const POST_LIMIT = 5;
const BROWSER_RESTART_MS = 60 * 60 * 1000;

const GROUPS = [
  'toolwebapp', 'thietkewebvietnam', '1685891735047297',
  '606643771643699', '1104882584238051', '1712169349298592',
  '1998083910206781', 'n8n.automation'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' }); }
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(ROOT, 'scraper.log'), line + '\n');
}

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function checkLogin(page) {
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);
  return (await page.locator('input[name="email"]').count()) === 0;
}

function groupUrl(gid) {
  return `https://www.facebook.com/groups/${gid}/?sorting_setting=CHRONOLOGICAL`;
}

async function scrapeTab(context, groupId, coreScript) {
  let page;
  try {
    page = await context.newPage();
  } catch (err) {
    return { success: false, groupId, error: `newPage failed: ${err.message}` };
  }
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
    try { await page.close(); } catch { }
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
    // Close stale pages between batches
    try {
      const pages = context.pages();
      for (let j = 1; j < pages.length; j++) { try { await pages[j].close(); } catch {} }
    } catch {}
    if (i + CONCURRENCY < GROUPS.length) await sleep(2000);
  }

  if (retryQueue.length > 0) {
    log(`  🔄 Retrying ${retryQueue.length} groups (single-tab)...`);
    const retryPage = context.pages()[0] || await context.newPage();
    for (const gid of retryQueue) {
      try {
        await retryPage.goto(groupUrl(gid), { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(4000);
        await retryPage.evaluate(coreScript);
        const data = await retryPage.evaluate(async ({ groupId, limit }) => {
          return await window.__fbGroupExtractor({ groupId, limit });
        }, { groupId: gid, limit: POST_LIMIT });
        const posts = data.posts || [];
        if (posts.length > 0) { results.push({ success: true, groupId: gid, count: posts.length, posts }); log(`  ✅ ${gid} (retry): ${posts.length} bài`); }
        else { results.push({ success: false, groupId: gid, count: 0, posts: [] }); log(`  ❌ ${gid} (retry): 0 posts`); }
      } catch (err) {
        results.push({ success: false, groupId: gid, count: 0, posts: [] });
        log(`  ❌ ${gid} (retry): ${err.message}`);
      }
      await sleep(1500);
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const succeeded = results.filter(r => r.success).length;
  const summary = { cycle: cycleNum, timestamp: now(), total: results.length, succeeded, failed: results.length - succeeded, results };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');
  log(`━━━ CYCLE #${cycleNum} DONE: ${succeeded}/${results.length} groups OK ━━━`);
}

async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1440, height: 1200 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function main() {
  log('========================================');
  log(`FB SCRAPER v2 — multi-tab | interval: ${CYCLE_INTERVAL_MS / 1000}s | restart every ${BROWSER_RESTART_MS / 60000}min`);
  log(`Groups: ${GROUPS.length} | Concurrency: ${CONCURRENCY}`);
  log('========================================');

  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  let cycleNum = 0;
  let context = await launchBrowser();
  let browserStartTime = Date.now();
  let mainPage = context.pages()[0] || await context.newPage();

  // === LOGIN CHECK ===
  log('🔐 Kiểm tra đăng nhập Facebook...');
  let loggedIn = await checkLogin(mainPage);
  while (!loggedIn) {
    log('⚠️ CHƯA ĐĂNG NHẬP! Hãy đăng nhập Facebook trên trình duyệt vừa mở.');
    await waitForEnter('👉 Đăng nhập + xác minh 2FA xong, nhấn ENTER để tiếp tục...');
    loggedIn = await checkLogin(mainPage);
    if (!loggedIn) log('❌ Vẫn chưa đăng nhập. Thử lại...');
  }
  log('✅ Đã đăng nhập Facebook! Bắt đầu scrape...');

  while (true) {
    if (Date.now() - browserStartTime >= BROWSER_RESTART_MS) {
      log('🔄 Hourly browser restart...');
      try { await context.close(); } catch { }
      await sleep(3000);
      context = await launchBrowser();
      browserStartTime = Date.now();
      mainPage = context.pages()[0] || await context.newPage();
      log('✅ Browser restarted');
    }

    cycleNum++;
    try { await runCycle(context, coreScript, cycleNum); } catch (err) { log(`CYCLE ERROR: ${err.message}`); }

    // Cleanup stale pages
    try {
      const pages = context.pages();
      for (let i = 1; i < pages.length; i++) { try { await pages[i].close(); } catch { } }
    } catch { }

    log(`Sleeping ${CYCLE_INTERVAL_MS / 1000}s...`);
    await sleep(CYCLE_INTERVAL_MS);
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
