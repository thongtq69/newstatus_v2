const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const readline = require('readline');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-commenter-profile');
const LATEST_FILE = path.join(ROOT, 'scrape-results', 'latest.json');
const COMMENTED_FILE = path.join(ROOT, 'commented-posts.json');
const BROWSER_RESTART_MS = 60 * 60 * 1000;

const COMMENT_TEXT = `Em nhận build trang web hoàn chỉnh ,Ib 2m vào việc , 45p có demo giao diện . 2 ngày bàn giao . Thanh toán sau nên bao uy tín chất lượng. Có hoá đơn chứng từ doanh nghiệp nếu cần ạ.`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' }); }
function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(path.join(ROOT, 'commenter.log'), line + '\n');
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
  const loginForm = await page.locator('input[name="email"]').count();
  return loginForm === 0;
}

function loadCommented() {
  try { return new Set(JSON.parse(fs.readFileSync(COMMENTED_FILE, 'utf8'))); }
  catch { return new Set(); }
}
function saveCommented(set) {
  fs.writeFileSync(COMMENTED_FILE, JSON.stringify([...set].slice(-5000), null, 2), 'utf8');
}

async function commentOnPost(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    const inserted = await page.evaluate((text) => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) return false;
      tb.click(); tb.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(tb); range.collapse(false);
      sel.removeAllRanges(); sel.addRange(range);
      tb.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text,
        bubbles: true, cancelable: true, composed: true
      }));
      return true;
    }, COMMENT_TEXT);

    if (!inserted) { log(`  ⚠️ No textbox: ${postUrl}`); return false; }

    await page.waitForTimeout(500);
    const content = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb ? tb.textContent : '';
    });
    if (!content.includes('build trang web')) { log(`  ⚠️ Text not inserted: ${postUrl}`); return false; }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    const after = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb ? tb.textContent : '';
    });
    if (after === '') { log(`  💬 OK: ${postUrl}`); return true; }
    else { log(`  ⚠️ May not have sent: ${postUrl}`); return false; }
  } catch (err) {
    log(`  ❌ FAIL: ${postUrl} — ${err.message}`);
    return false;
  }
}

async function processNewPosts(page) {
  let data;
  try { data = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8')); } catch { return; }

  const commented = loadCommented();
  const newPosts = [];
  for (const group of (data.results || [])) {
    if (!group.success || !group.posts) continue;
    for (const post of group.posts) {
      if (!post.postId || commented.has(post.postId)) continue;
      if (post.author && post.author.includes('WinterFrost')) continue;
      newPosts.push({ ...post, groupId: group.groupId });
    }
  }

  if (!newPosts.length) { log('📝 Không có bài mới'); return; }
  log(`📝 ${newPosts.length} bài mới cần comment`);

  let ok = 0;
  for (const post of newPosts) {
    const url = post.url || `https://www.facebook.com/groups/${post.groupId}/posts/${post.postId}/`;
    if (await commentOnPost(page, url)) { commented.add(post.postId); ok++; }
    await page.waitForTimeout(3000);
  }
  saveCommented(commented);
  log(`✅ Done: ${ok}/${newPosts.length} | Total tracked: ${commented.size}`);
}

async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false, viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function main() {
  log('========================================');
  log('FB COMMENTER v3 — InputEvent + single tab + fs.watch');
  log(`Browser restart every ${BROWSER_RESTART_MS / 60000} min`);
  log('========================================');

  let context = await launchBrowser();
  let browserStart = Date.now();
  let page = context.pages()[0] || await context.newPage();

  // === LOGIN CHECK ===
  log('🔐 Kiểm tra đăng nhập Facebook...');
  let loggedIn = await checkLogin(page);
  while (!loggedIn) {
    log('⚠️ CHƯA ĐĂNG NHẬP! Hãy đăng nhập Facebook trên trình duyệt vừa mở.');
    await waitForEnter('👉 Đăng nhập + xác minh 2FA xong, nhấn ENTER để tiếp tục...');
    loggedIn = await checkLogin(page);
    if (!loggedIn) log('❌ Vẫn chưa đăng nhập. Thử lại...');
  }
  log('✅ Đã đăng nhập Facebook! Bắt đầu comment...');

  let processing = false, pending = false;

  async function onTrigger() {
    if (processing) { pending = true; return; }
    processing = true;
    try {
      if (Date.now() - browserStart >= BROWSER_RESTART_MS) {
        log('🔄 Hourly browser restart...');
        try { await context.close(); } catch {}
        await sleep(3000);
        context = await launchBrowser();
        browserStart = Date.now();
        page = context.pages()[0] || await context.newPage();
        log('✅ Browser restarted');
      }
      await processNewPosts(page);
    } catch (err) { log(`ERROR: ${err.message}`); }
    processing = false;
    if (pending) { pending = false; await onTrigger(); }
  }

  await onTrigger();

  log('👁️ Watching latest.json...');
  let debounce = null;
  fs.watch(LATEST_FILE, { persistent: true }, (evt) => {
    if (evt === 'change') {
      clearTimeout(debounce);
      debounce = setTimeout(() => { log('📢 latest.json changed!'); onTrigger(); }, 2000);
    }
  });

  setInterval(async () => {
    if (Date.now() - browserStart >= BROWSER_RESTART_MS && !processing) {
      log('🔄 Scheduled restart...');
      try { await context.close(); } catch {}
      await sleep(3000);
      context = await launchBrowser();
      browserStart = Date.now();
      page = context.pages()[0] || await context.newPage();
      log('✅ Restarted');
    }
  }, 5 * 60 * 1000);

  await new Promise(() => {});
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
