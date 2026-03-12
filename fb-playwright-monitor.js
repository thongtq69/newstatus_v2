const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const STATE_FILE = path.join(ROOT, '.pw-facebook-storage.json');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function launchPersistent(headless = false) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1440, height: 1200 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  return context;
}

async function saveState(context) {
  const state = await context.storageState();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

async function cmdLogin() {
  const context = await launchPersistent(false);
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  console.log('LOGIN_MODE_OPEN');
  console.log('Please log into Facebook in the opened Playwright window.');
  console.log('After login is complete and feed is visible, press Ctrl+C to stop this command.');

  const interval = setInterval(async () => {
    try {
      const url = page.url();
      const hasLoginForm = await page.locator('input[name="email"]').count();
      if (!hasLoginForm && /facebook\.com/.test(url)) {
        await saveState(context);
        console.log('LOGIN_STATE_SAVED');
      }
    } catch {}
  }, 4000);

  process.on('SIGINT', async () => {
    clearInterval(interval);
    try { await saveState(context); } catch {}
    try { await context.close(); } catch {}
    process.exit(0);
  });
}

async function cmdStatus() {
  const exists = fs.existsSync(STATE_FILE) || fs.existsSync(PROFILE_DIR);
  console.log(JSON.stringify({ success: true, hasProfile: exists, profileDir: PROFILE_DIR, stateFile: STATE_FILE }, null, 2));
}

async function extractPosts(page, groupId, limit = 5) {
  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  await page.addInitScript(coreScript);
  await page.evaluate(coreScript);
  const result = await page.evaluate(async ({ groupId, limit }) => {
    if (typeof window.__fbGroupExtractor !== 'function') {
      throw new Error('Core extractor is not installed on page');
    }
    return await window.__fbGroupExtractor({ groupId, limit });
  }, { groupId, limit });
  return result.posts || [];
}

async function cmdScrape(groupUrl, limit = 5) {
  const context = await launchPersistent(false);
  const page = context.pages()[0] || await context.newPage();
  await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });
  await sleep(4000);

  const hasLoginForm = await page.locator('input[name="email"]').count();
  if (hasLoginForm) {
    console.log(JSON.stringify({ success: false, error: 'Not logged in in Playwright profile. Run: node fb-playwright-monitor.js login' }, null, 2));
    await context.close();
    return;
  }

  const m = groupUrl.match(/\/groups\/([^/?#]+)/i);
  const groupId = m ? m[1] : '';
  const posts = await extractPosts(page, groupId, limit);
  await saveState(context);
  console.log(JSON.stringify({ success: true, groupUrl, count: posts.length, posts }, null, 2));
  await context.close();
}

async function scrapeOneTab(context, groupUrl, limit, coreScript) {
  const page = await context.newPage();
  const m = groupUrl.match(/\/groups\/([^/?#]+)/i);
  const groupId = m ? m[1] : '';
  try {
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(4000);

    const hasLoginForm = await page.locator('input[name="email"]').count();
    if (hasLoginForm) {
      return { success: false, groupUrl, groupId, error: 'Not logged in' };
    }

    await page.evaluate(coreScript);
    const result = await page.evaluate(async ({ groupId, limit }) => {
      return await window.__fbGroupExtractor({ groupId, limit });
    }, { groupId, limit });

    return { success: true, groupUrl, groupId, count: (result.posts || []).length, posts: result.posts || [] };
  } catch (err) {
    return { success: false, groupUrl, groupId, error: err.message };
  } finally {
    await page.close().catch(() => {});
  }
}

async function cmdScrapeMulti(groupUrls, limit = 5, concurrency = 5) {
  const context = await launchPersistent(false);
  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');

  // Process in batches to avoid overwhelming the browser
  const results = [];
  for (let i = 0; i < groupUrls.length; i += concurrency) {
    const batch = groupUrls.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(url => scrapeOneTab(context, url, limit, coreScript))
    );
    results.push(...batchResults);
    // Small pause between batches
    if (i + concurrency < groupUrls.length) await sleep(2000);
  }

  await saveState(context);
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  console.log(JSON.stringify({ success: true, total: results.length, succeeded, failed, results }, null, 2));
  await context.close();
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'login') return cmdLogin();
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'scrape') {
    const url = process.argv[3];
    const limit = Number(process.argv[4] || '5');
    if (!url) throw new Error('Usage: node fb-playwright-monitor.js scrape <groupUrl> [limit]');
    return cmdScrape(url, limit);
  }
  if (cmd === 'scrape-multi') {
    // Usage: node fb-playwright-monitor.js scrape-multi <url1,url2,...> [limit] [concurrency]
    const urlsArg = process.argv[3];
    const limit = Number(process.argv[4] || '5');
    const concurrency = Number(process.argv[5] || '5');
    if (!urlsArg) throw new Error('Usage: node fb-playwright-monitor.js scrape-multi <url1,url2,...> [limit] [concurrency]');
    const groupUrls = urlsArg.split(',').map(u => u.trim()).filter(Boolean);
    return cmdScrapeMulti(groupUrls, limit, concurrency);
  }
  console.log('Usage: node fb-playwright-monitor.js <login|status|scrape|scrape-multi>');
})();
