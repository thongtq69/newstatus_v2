const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-commenter-profile');
const COMMENT_TEXT = `Em nhận build trang web hoàn chỉnh ,Ib 2m vào việc , 45p có demo giao diện . 2 ngày bàn giao . Thanh toán sau nên bao uy tín chất lượng. Có hoá đơn chứng từ doanh nghiệp nếu cần ạ.`;

// Get posts from latest.json for 1 group
const latest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scrape-results', 'latest.json'), 'utf8'));
const group = latest.results.find(r => r.groupId === 'thietkewebvietnam' && r.success);
if (!group || !group.posts.length) { console.log('No posts found'); process.exit(1); }

const posts = group.posts;
console.log(`Found ${posts.length} posts in thietkewebvietnam`);

async function commentOnPost(page, postUrl) {
  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(5000);

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    // Focus textbox + insert text via InputEvent (same as Chrome relay test)
    const inserted = await page.evaluate((text) => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      if (!tb) return 'no textbox';
      tb.click();
      tb.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(tb);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
      tb.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
        composed: true
      }));
      return tb.textContent;
    }, COMMENT_TEXT);

    if (inserted === 'no textbox') {
      console.log(`  ⚠️ No textbox: ${postUrl}`);
      return false;
    }

    // Verify text is in textbox
    await page.waitForTimeout(500);
    const content = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb ? tb.textContent : '';
    });

    if (!content.includes('build trang web')) {
      console.log(`  ⚠️ Text not inserted: ${postUrl}`);
      return false;
    }

    // Press Enter to submit
    await page.keyboard.press('Enter');
    await page.waitForTimeout(5000);

    // Verify textbox is empty (comment sent)
    const after = await page.evaluate(() => {
      const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
      return tb ? tb.textContent : '';
    });

    if (after === '') {
      console.log(`  💬 OK: ${postUrl}`);
      return true;
    } else {
      console.log(`  ⚠️ Comment may not have sent: ${postUrl}`);
      return false;
    }
  } catch (err) {
    console.log(`  ❌ FAIL: ${postUrl} — ${err.message}`);
    return false;
  }
}

(async () => {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || await context.newPage();
  let ok = 0, fail = 0;

  for (const post of posts) {
    const url = post.url || `https://www.facebook.com/groups/thietkewebvietnam/posts/${post.postId}/`;
    const result = await commentOnPost(page, url);
    if (result) ok++; else fail++;
    await page.waitForTimeout(3000);
  }

  console.log(`\n✅ Done: ${ok} OK, ${fail} failed out of ${posts.length}`);
  await context.close();
  process.exit(0);
})();
