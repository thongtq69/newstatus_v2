const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const readline = require('readline');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core_v2.js');
const RESULTS_DIR = path.join(ROOT, 'scrape-results');

const CYCLE_INTERVAL_MS = 2 * 60 * 1000;
const NAV_TIMEOUT_MS = 30000;
const POST_LIMIT = 5;
const BROWSER_RESTART_MS = 60 * 60 * 1000;
const BATCH_SIZE = 5;

const GROUPS = [
  'toolwebapp',
  'thietkewebvietnam',
  '1685891735047297',
  '606643771643699',
  '1104882584238051',
  '1712169349298592',
  '1998083910206781',
  'n8n.automation',
  '4387300028062377',
  '362900488947380',
  'congdongthietkewebsitegiare',
  'hoithietkewebsiteviet'
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

async function cleanupExtraPages(context, keepPages = []) {
  const keepSet = new Set(keepPages.filter(Boolean));
  const pages = context.pages();
  let closed = 0;
  for (const p of pages) {
    if (keepSet.has(p)) continue;
    try {
      await p.close({ runBeforeUnload: false });
      closed++;
    } catch {}
  }
  return closed;
}

function attachStrayPageAutoCloser(context, getMainPages) {
  const onPage = page => {
    (async () => {
      const started = Date.now();
      while (!page.isClosed() && Date.now() - started < 1500) {
        const protectedPages = new Set((getMainPages() || []).filter(Boolean));
        if (protectedPages.has(page)) return;
        const url = page.url() || '';
        if (url && url !== 'about:blank') break;
        await sleep(100);
      }

      if (page.isClosed()) return;
      const protectedPages = new Set((getMainPages() || []).filter(Boolean));
      if (protectedPages.has(page)) return;

      const url = page.url() || 'about:blank';
      log(`🧹 Auto-closing stray page: ${url}`);
      try {
        await page.close({ runBeforeUnload: false });
      } catch {}
    })().catch(() => {});
  };

  context.on('page', onPage);
  return () => {
    try { context.off('page', onPage); } catch {}
  };
}

async function scrapeGroup(page, groupId, coreScript, context, keepPages = []) {
  try {
    await page.goto(groupUrl(groupId), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    await sleep(4000);
    if (await page.locator('input[name="email"]').count()) {
      return { success: false, groupId, error: 'Not logged in' };
    }
    await page.evaluate(coreScript);
    const data = await page.evaluate(async ({ groupId, limit }) => {
      return await window.__fbGroupExtractor({ groupId, limit });
    }, { groupId, limit: POST_LIMIT });
    const closedExtraPages = context ? await cleanupExtraPages(context, keepPages) : 0;
    const posts = data.posts || [];
    return {
      success: posts.length > 0,
      groupId,
      mode: data.mode,
      count: posts.length,
      unresolvedCount: data.unresolvedCount || 0,
      posts,
      unresolvedCards: data.unresolvedCards || [],
      closedExtraPages
    };
  } catch (err) {
    return { success: false, groupId, error: err.message.split('\n')[0] };
  }
}

async function runBatch(context, pages, coreScript, cycleNum, batchNum, groupBatch, options = {}) {
  const { isRetryBatch = false } = options;
  log(`  ▶ ${isRetryBatch ? 'Retry batch' : `Batch ${batchNum}`}: ${groupBatch.join(', ')}`);
  const keepPages = pages.filter(Boolean);
  const jobs = groupBatch.map(async (gid, index) => {
    const page = pages[index];
    if (!page) {
      return {
        success: false,
        groupId: gid,
        count: 0,
        posts: [],
        unresolvedCards: [],
        error: 'No page assigned',
        retryEligible: false,
        retried: isRetryBatch,
      };
    }

    const r = await scrapeGroup(page, gid, coreScript, context, keepPages);
    if (r.success) {
      log(`    ✅ ${r.groupId}: ${r.count} bài | unresolved=${r.unresolvedCount || 0}${isRetryBatch ? ' | retry-ok' : ''}`);
      return { ...r, retryEligible: false, retried: isRetryBatch };
    }

    const error = r.error || '0 posts';
    const retryEligible = error === '0 posts';
    if (isRetryBatch) {
      log(`    ⚠️ ${gid}: ${error} — retry exhausted`);
    } else if (retryEligible) {
      log(`    ⚠️ ${gid}: ${error} — queue retry after all batches`);
    } else {
      log(`    ⚠️ ${gid}: ${error} — defer retry to next cycle`);
    }

    return {
      success: false,
      groupId: gid,
      count: 0,
      posts: [],
      unresolvedCards: [],
      error,
      retryEligible,
      retried: isRetryBatch,
    };
  });

  return await Promise.all(jobs);
}

async function runCycle(context, pages, coreScript, cycleNum) {
  log(`━━━ CYCLE #${cycleNum} START (v1 entrypoint, V2 logic) ━━━`);
  const results = [];
  const batches = [];
  for (let i = 0; i < GROUPS.length; i += BATCH_SIZE) {
    batches.push(GROUPS.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i++) {
    const batchResults = await runBatch(context, pages, coreScript, cycleNum, i + 1, batches[i]);
    results.push(...batchResults);
    if (i < batches.length - 1) {
      log('  ⏳ Cooldown giữa 2 batch...');
      await sleep(2500);
    }
  }

  const retryGroups = [];
  for (const r of results) {
    if (r && !r.success && r.retryEligible) retryGroups.push(r.groupId);
  }

  if (retryGroups.length > 0) {
    log(`  🔁 Final retry pass for 0-post groups: ${retryGroups.join(', ')}`);
    const retryResults = await runBatch(context, pages, coreScript, cycleNum, 'retry', retryGroups, { isRetryBatch: true });
    const retryMap = new Map(retryResults.map(r => [r.groupId, r]));
    for (let i = 0; i < results.length; i++) {
      const gid = results[i]?.groupId;
      if (retryMap.has(gid)) results[i] = retryMap.get(gid);
    }
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const succeeded = results.filter(r => r.success).length;
  const summary = {
    version: 'v1-on-v2-logic',
    cycle: cycleNum,
    timestamp: now(),
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    batchSize: BATCH_SIZE,
    results
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');
  log(`━━━ CYCLE #${cycleNum} DONE: ${succeeded}/${results.length} groups OK ━━━`);
}

async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function main() {
  log('========================================');
  log(`FB SCRAPER v1 entrypoint — now running V2 logic | batch ${BATCH_SIZE} | interval: ${CYCLE_INTERVAL_MS / 1000}s | restart every ${BROWSER_RESTART_MS / 60000}min`);
  log(`Groups: ${GROUPS.length}`);
  log(`Core: ${path.basename(CORE_EXTRACTOR_FILE)}`);
  log('========================================');

  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  let cycleNum = 0;
  let context = await launchBrowser();
  let browserStartTime = Date.now();
  let pages = context.pages();
  while (pages.length < BATCH_SIZE) pages.push(await context.newPage());
  let loginPage = pages[0];
  let detachAutoCloser = attachStrayPageAutoCloser(context, () => pages);

  log('🔐 Kiểm tra đăng nhập Facebook...');
  let loggedIn = await checkLogin(loginPage);
  while (!loggedIn) {
    log('⚠️ CHƯA ĐĂNG NHẬP! Hãy đăng nhập Facebook trên trình duyệt vừa mở.');
    await waitForEnter('👉 Đăng nhập + xác minh 2FA xong, nhấn ENTER để tiếp tục...');
    loggedIn = await checkLogin(loginPage);
    if (!loggedIn) log('❌ Vẫn chưa đăng nhập. Thử lại...');
  }
  log('✅ Đã đăng nhập Facebook! Bắt đầu scrape...');

  while (true) {
    if (Date.now() - browserStartTime >= BROWSER_RESTART_MS) {
      log('🔄 Hourly browser restart...');
      try { detachAutoCloser && detachAutoCloser(); } catch {}
      try { await context.close(); } catch {}
      await sleep(3000);
      context = await launchBrowser();
      browserStartTime = Date.now();
      pages = context.pages();
      while (pages.length < BATCH_SIZE) pages.push(await context.newPage());
      loginPage = pages[0];
      detachAutoCloser = attachStrayPageAutoCloser(context, () => pages);
      log('✅ Browser restarted');
    }

    cycleNum++;
    try { await runCycle(context, pages, coreScript, cycleNum); }
    catch (err) { log(`CYCLE ERROR: ${err.message}`); }

    log(`Sleeping ${CYCLE_INTERVAL_MS / 1000}s...`);
    await sleep(CYCLE_INTERVAL_MS);
  }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
