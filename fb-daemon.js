const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-facebook-profile');
const CORE_EXTRACTOR_FILE = path.join(ROOT, 'extract_group_posts_core.js');
const RESULTS_DIR = path.join(ROOT, 'scrape-results');
const COMMENTED_FILE = path.join(ROOT, 'commented-posts.json');

// Config
const CYCLE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const TAB_TIMEOUT_MS = 30 * 1000;
const CONCURRENCY = 5;
const POST_LIMIT = 3;

const COMMENT_TEXT = `Em nhận build trang web hoàn chỉnh ,Ib 2m vào việc , 45p có demo giao diện . 2 ngày bàn giao . Thanh toán sau nên bao uy tín chất lượng. Có hoá đơn chứng từ doanh nghiệp nếu cần ạ.`;

// Groups that should get auto-comment (Tech/Web only)
const COMMENT_GROUPS = new Set([
  'toolwebapp', 'thietkewebvietnam', '1685891735047297', '362900488947380',
  '606643771643699', '1104882584238051', 'congdongthietkewebsitegiare',
  '1712169349298592', 'hoithietkewebsiteviet', '1998083910206781',
  'n8n.automation'
]);

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

function groupUrl(gid) {
  return `https://www.facebook.com/groups/${gid}/?sorting_setting=CHRONOLOGICAL`;
}

// Load/save commented posts set
function loadCommented() {
  try {
    const data = JSON.parse(fs.readFileSync(COMMENTED_FILE, 'utf8'));
    return new Set(data);
  } catch { return new Set(); }
}

function saveCommented(set) {
  // Keep only last 5000 to avoid unbounded growth
  const arr = [...set];
  const trimmed = arr.slice(-5000);
  fs.writeFileSync(COMMENTED_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

async function commentOnPost(context, postUrl, coreScript) {
  const page = await context.newPage();
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(4000);

    // Strategy: scroll to bottom first, then find & force-click the comment button/box
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);

    // FB comment flow: there's a "Viết bình luận" button (role=button). 
    // Click it via JS to bypass overlay intercepts, which opens the actual textbox.
    const clicked = await page.evaluate(() => {
      // Find "Viết bình luận" button
      const btns = document.querySelectorAll('[role="button"][aria-label*="bình luận"], [role="button"][aria-label*="Bình luận"]');
      for (const btn of btns) {
        btn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      log(`    ⚠️ No comment button on ${postUrl}`);
      return false;
    }

    await sleep(2000);

    // Now the actual textbox should appear — it's a contenteditable div with role="textbox"
    // Type using keyboard (more reliable than execCommand on contenteditable)
    const textbox = page.locator('[role="textbox"][contenteditable="true"]').last();
    if (await textbox.count() === 0) {
      log(`    ⚠️ Textbox didn't appear after clicking on ${postUrl}`);
      return false;
    }

    await textbox.click({ force: true });
    await sleep(500);

    // Type via execCommand
    await page.evaluate((text) => {
      document.execCommand('insertText', false, text);
    }, COMMENT_TEXT);
    await sleep(1000);

    // Submit with Enter
    await page.keyboard.press('Enter');
    await sleep(4000);

    log(`    💬 Commented on ${postUrl}`);
    return true;
  } catch (err) {
    log(`    ❌ Comment failed ${postUrl}: ${err.message}`);
    return false;
  } finally {
    try { await page.close(); } catch {}
  }
}

async function scrapeTab(context, groupId, coreScript) {
  const page = await context.newPage();
  const url = groupUrl(groupId);
  
  try {
    const result = await Promise.race([
      (async () => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(4000);
        
        const loginForm = await page.locator('input[name="email"]').count();
        if (loginForm) return { success: false, groupId, error: 'Not logged in' };
        
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

async function runCycle(context, coreScript, cycleNum, commentedPosts) {
  log(`━━━ CYCLE #${cycleNum} START ━━━`);
  
  const allResults = [];
  const retryQueue = [];
  const newPostsToComment = [];
  
  // Scrape in batches
  for (let i = 0; i < GROUPS.length; i += CONCURRENCY) {
    const batch = GROUPS.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(gid => scrapeTab(context, gid, coreScript))
    );
    
    for (const r of batchResults) {
      if (r.success) {
        allResults.push(r);
        log(`  ✅ ${r.groupId}: ${r.count} bài`);
        
        // Check for new posts to comment (only tech/web groups)
        if (COMMENT_GROUPS.has(r.groupId)) {
          for (const post of r.posts) {
            if (post.postId && !commentedPosts.has(post.postId)) {
              // Skip posts by WinterFrost (our own posts)
              if (post.author && post.author.includes('WinterFrost')) continue;
              newPostsToComment.push(post);
            }
          }
        }
      } else if (r.timedOut || (!r.error || r.error !== 'Not logged in')) {
        retryQueue.push(r.groupId);
        log(`  ⚠️ ${r.groupId}: ${r.timedOut ? 'TIMEOUT' : '0 posts'} — will retry`);
      } else {
        allResults.push(r);
        log(`  ❌ ${r.groupId}: ${r.error}`);
      }
    }
    
    if (i + CONCURRENCY < GROUPS.length) await sleep(1500);
  }
  
  // Retry failed
  if (retryQueue.length > 0) {
    log(`  🔄 Retrying ${retryQueue.length} groups...`);
    for (const gid of retryQueue) {
      const r = await scrapeTab(context, gid, coreScript);
      if (r.success) {
        allResults.push(r);
        log(`  ✅ ${gid} (retry): ${r.count} bài`);
        if (COMMENT_GROUPS.has(gid)) {
          for (const post of r.posts) {
            if (post.postId && !commentedPosts.has(post.postId)) {
              if (post.author && post.author.includes('WinterFrost')) continue;
              newPostsToComment.push(post);
            }
          }
        }
      } else {
        allResults.push({ success: false, groupId: gid, error: r.error || '0 posts', count: 0, posts: [] });
        log(`  ❌ ${gid} (retry): ${r.error || 'still 0'}`);
      }
    }
  }
  
  // Comment on new posts
  if (newPostsToComment.length > 0) {
    log(`  📝 ${newPostsToComment.length} bài mới cần comment...`);
    for (const post of newPostsToComment) {
      const postUrl = post.url || `https://www.facebook.com/groups/${post.groupId || ''}/posts/${post.postId}/`;
      const ok = await commentOnPost(context, postUrl, coreScript);
      if (ok) {
        commentedPosts.add(post.postId);
      }
      // Don't mark failed ones — retry next cycle
      // Small delay between comments to avoid spam detection
      await sleep(3000);
    }
    saveCommented(commentedPosts);
  } else {
    log(`  📝 Không có bài mới cần comment`);
  }
  
  // Save results
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const succeeded = allResults.filter(r => r.success).length;
  const summary = {
    cycle: cycleNum,
    timestamp: now(),
    total: allResults.length,
    succeeded,
    failed: allResults.length - succeeded,
    newComments: newPostsToComment.length,
    commentedTotal: commentedPosts.size,
    results: allResults
  };
  fs.writeFileSync(path.join(RESULTS_DIR, 'latest.json'), JSON.stringify(summary, null, 2), 'utf8');
  
  log(`━━━ CYCLE #${cycleNum} DONE: ${succeeded}/${allResults.length} groups | ${newPostsToComment.length} comments ━━━`);
  return summary;
}

async function main() {
  log('========================================');
  log(`FB Daemon v2 — interval: ${CYCLE_INTERVAL_MS/1000}s | auto-comment ON`);
  log(`Tech groups (comment): ${COMMENT_GROUPS.size} | Total: ${GROUPS.length}`);
  log('========================================');
  
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1440, height: 1200 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  
  const coreScript = fs.readFileSync(CORE_EXTRACTOR_FILE, 'utf8');
  const commentedPosts = loadCommented();
  log(`Loaded ${commentedPosts.size} previously commented posts`);
  
  let cycleNum = 0;
  
  while (true) {
    cycleNum++;
    try {
      await runCycle(context, coreScript, cycleNum, commentedPosts);
    } catch (err) {
      log(`CYCLE #${cycleNum} ERROR: ${err.message}`);
    }
    
    // Cleanup stale pages
    const pages = context.pages();
    for (let i = 1; i < pages.length; i++) {
      try { await pages[i].close(); } catch {}
    }
    
    log(`Sleeping ${CYCLE_INTERVAL_MS/1000}s...`);
    await sleep(CYCLE_INTERVAL_MS);
  }
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
