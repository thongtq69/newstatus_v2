const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const readline = require('readline');
const { readDb, writeDb, DB_FILE } = require('./post-store');

const ROOT = __dirname;
const PROFILE_DIR = path.join(ROOT, '.pw-commenter-profile');
const COMMENTED_FILE = path.join(ROOT, 'commented-posts.json');
const REJECTED_FILE = path.join(ROOT, 'rejected-posts.json');
const GROUP_RULES_FILE = path.join(ROOT, 'group-comment-rules.json');
const SKIPPED_FILE = path.join(ROOT, 'skipped-posts.json');
const LOCK_FILE = path.join(ROOT, '.fb-commenter.lock');
const BROWSER_RESTART_MS = 60 * 60 * 1000;
const RETRY_DELAY_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 2;

const COMMENT_VARIANTS = [
  `✅ Nhận build website trọn gói – Inbox là bắt đầu ngay! Demo giao diện trong 45 phút, bàn giao hoàn chỉnh sau 2 ngày làm việc. Thanh toán sau khi nghiệm thu – cam kết uy tín & chất lượng tuyệt đối. Xuất hoá đơn VAT doanh nghiệp đầy đủ nếu quý khách có nhu cầu. 🌐 https://winterfrost.tech/`,
  `🔥 Nhận làm website toàn bộ hệ thống – Ib ngay, 45p có demo liền tay! Deadline bàn giao: 2 ngày. Thanh toán sau khi nhận hàng – không cọc, không rủi ro. Có đầy đủ hoá đơn chứng từ cho doanh nghiệp. 🌐 https://winterfrost.tech/`,
  `💻 Bạn cần build website? Mình nhận làm toàn bộ hệ thống – nhắn tin là vào việc ngay! Chỉ 45 phút là có demo giao diện xem trước, 2 ngày là bàn giao xong xuôi. Thanh toán sau nên hoàn toàn yên tâm về chất lượng. Cần hoá đơn doanh nghiệp mình xuất luôn nhé! 🌐 https://winterfrost.tech/`,
  `⚡ Nhận xây dựng website hệ thống – cam kết tiến độ & chất lượng! Inbox là triển khai ngay, 45 phút có demo giao diện cụ thể, bàn giao trong vòng 2 ngày. Chính sách thanh toán sau – đảm bảo quyền lợi cho khách hàng 100%. Hỗ trợ xuất hoá đơn, chứng từ theo yêu cầu doanh nghiệp. 🌐 https://winterfrost.tech/`,
  `🚀 Build website chuyên nghiệp – Ib trong 2 phút, vào việc ngay lập tức! Demo giao diện sau 45 phút, bàn giao toàn bộ hệ thống chỉ trong 2 ngày. Thanh toán sau khi nhận – bao uy tín, không lo rủi ro. Xuất hoá đơn VAT doanh nghiệp theo yêu cầu. Liên hệ ngay để được tư vấn miễn phí! 🌐 https://winterfrost.tech/`
];

const RETRYABLE_STATUSES = new Set([
  'new',
  'retry_pending',
  'submitted_unconfirmed',
  'may_not_have_sent',
  'failed',
  'failed_navigation',
  'failed_timeout',
  'no_textbox',
  'text_not_inserted'
]);

let suppressWatcherUntil = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function now() { return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' }); }
function nowIso() { return new Date().toISOString(); }
function setWatcherSuppressed(ms = 2500) { suppressWatcherUntil = Date.now() + ms; }
function isWatcherSuppressed() { return Date.now() < suppressWatcherUntil; }
function isoAfter(ms) { return new Date(Date.now() + ms).toISOString(); }
function safeWriteDb(db) {
  setWatcherSuppressed();
  writeDb(db);
}
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

function loadSet(file) {
  try { return new Set(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return new Set(); }
}
function saveSet(file, set) {
  fs.writeFileSync(file, JSON.stringify([...set].slice(-5000), null, 2), 'utf8');
}

function loadJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function loadGroupRules() { return loadJson(GROUP_RULES_FILE, {}); }
function saveGroupRules(data) { saveJson(GROUP_RULES_FILE, data); }

function normalizeForMatch(value) {
  return (value || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripLinkFromComment(commentText) {
  return commentText
    .replace(/\s*🌐\s*https?:\/\/\S+/gi, '')
    .replace(/\s*https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim() + ' Inbox em gửi demo và thông tin chi tiết ngay.';
}

function buildCommentSignatures(commentText) {
  const normalized = normalizeForMatch(commentText);
  const noLinkText = stripLinkFromComment(commentText);
  const signatures = [
    'winterfrost.tech',
    '45 phút',
    '2 ngày',
    'hoá đơn',
    'hóa đơn',
    'website',
    'demo giao diện',
    'inbox em gửi demo'
  ].filter(Boolean);
  return { normalized, noLinkText, signatures };
}

function createLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const raw = fs.readFileSync(LOCK_FILE, 'utf8');
      const data = JSON.parse(raw || '{}');
      if (data.pid) {
        try {
          process.kill(data.pid, 0);
          throw new Error(`fb-commenter.js is already running with PID ${data.pid}`);
        } catch (err) {
          if (err.code !== 'ESRCH') throw err;
        }
      }
    }
  } catch (err) {
    if (err.message.includes('already running')) throw err;
  }

  fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt: nowIso() }, null, 2), 'utf8');
}

function releaseLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    const data = JSON.parse(raw || '{}');
    if (data.pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch {}
}
function loadCommented() { return loadSet(COMMENTED_FILE); }
function saveCommented(set) { saveSet(COMMENTED_FILE, set); }
function loadRejected() { return loadSet(REJECTED_FILE); }
function saveRejected(set) { saveSet(REJECTED_FILE, set); }
function loadSkipped() { return loadSet(SKIPPED_FILE); }
function saveSkipped(set) { saveSet(SKIPPED_FILE, set); }

function pickRandomComment() {
  return COMMENT_VARIANTS[Math.floor(Math.random() * COMMENT_VARIANTS.length)];
}

function getCommentForGroup(groupId) {
  const base = pickRandomComment();
  const rules = loadGroupRules();
  const rule = rules[groupId] || {};
  if (rule.stripLink === true) {
    return { commentText: stripLinkFromComment(base), stripLink: true, ruleSource: 'group-rule' };
  }
  return { commentText: base, stripLink: false, ruleSource: 'default' };
}

function rememberGroupStripLink(groupId, evidence = {}) {
  const rules = loadGroupRules();
  rules[groupId] = {
    ...(rules[groupId] || {}),
    stripLink: true,
    updatedAt: nowIso(),
    reason: 'pending_with_link_block',
    evidence
  };
  saveGroupRules(rules);
}

function ensureCommentShape(post) {
  post.comment = post.comment || {};
  if (typeof post.comment.status !== 'string') post.comment.status = 'new';
  if (typeof post.comment.attemptCount !== 'number') post.comment.attemptCount = 0;
  if (!('lastAttemptAt' in post.comment)) post.comment.lastAttemptAt = null;
  if (!('lastCommentText' in post.comment)) post.comment.lastCommentText = null;
  if (!('lastResult' in post.comment)) post.comment.lastResult = null;
  if (!('confirmedAt' in post.comment)) post.comment.confirmedAt = null;
  if (!('rejectedAt' in post.comment)) post.comment.rejectedAt = null;
  if (!('markedDoneAt' in post.comment)) post.comment.markedDoneAt = null;
  if (!('processingAt' in post.comment)) post.comment.processingAt = null;
  if (!('queuedAt' in post.comment)) post.comment.queuedAt = null;
  if (!('nextRetryAt' in post.comment)) post.comment.nextRetryAt = null;
  if (!('actionType' in post.comment)) post.comment.actionType = null;
}

function getSortedCandidates(db) {
  const nowTs = Date.now();
  return Object.values(db.posts || {})
    .filter(post => {
      ensureCommentShape(post);
      if (!post.groupId || !post.postId || !post.url) return false;
      if (post.classification && post.classification.eligible === false) return false;
      if (post.author && /WinterFrost/i.test(post.author)) return false;
      if (!RETRYABLE_STATUSES.has(post.comment.status)) return false;
      if (post.comment.nextRetryAt) {
        const retryAt = new Date(post.comment.nextRetryAt).getTime();
        if (Number.isFinite(retryAt) && retryAt > nowTs) return false;
      }
      if (Number(post.comment.attemptCount || 0) >= MAX_ATTEMPTS && post.comment.status !== 'new') return false;
      return true;
    })
    .sort((a, b) => {
      const ap = Number(a.classification?.priority || 50);
      const bp = Number(b.classification?.priority || 50);
      if (bp !== ap) return bp - ap;
      const at = new Date(a.scrape?.firstSeenAt || 0).getTime();
      const bt = new Date(b.scrape?.firstSeenAt || 0).getTime();
      return bt - at;
    });
}

function claimNextPost() {
  const db = readDb();
  const candidates = getSortedCandidates(db);
  const post = candidates[0];
  if (!post) return null;

  ensureCommentShape(post);
  post.comment.status = 'processing';
  post.comment.processingAt = nowIso();
  post.comment.queuedAt = post.comment.queuedAt || post.comment.processingAt;
  safeWriteDb(db);
  return JSON.parse(JSON.stringify(post));
}

function updatePostComment(postKey, mutator) {
  const db = readDb();
  const post = db.posts?.[postKey];
  if (!post) return null;
  ensureCommentShape(post);
  mutator(post, db);
  db.updatedAt = nowIso();
  safeWriteDb(db);
  return post;
}

function syncLegacyTracking(postId, status) {
  const commented = loadCommented();
  const rejected = loadRejected();
  const skipped = loadSkipped();
  if (status === 'sent_confirmed') commented.add(postId);
  if (status === 'rejected') rejected.add(postId);
  if (status === 'blocked_no_comment_permission') skipped.add(postId);
  saveCommented(commented);
  saveRejected(rejected);
  saveSkipped(skipped);
}

async function verifyCommentResult(page, commentText, actionType = '') {
  const { normalized: expectedCommentNorm, signatures } = buildCommentSignatures(commentText);
  return await page.evaluate(({ expectedCommentNorm, signatures, actionType }) => {
    const normalize = value => (value || '').toString().toLowerCase().replace(/\s+/g, ' ').trim();
    const tb = document.querySelector('[role="textbox"][contenteditable="true"]');
    const pageTextRaw = document.body ? document.body.innerText : '';
    const pageText = pageTextRaw.replace(/\s+/g, ' ');
    const pageTextNorm = normalize(pageText);
    const textboxTextAfter = tb ? (tb.textContent || '') : '';
    const textboxEmpty = textboxTextAfter === '';
    const hasRejected = /Bị từ chối/i.test(pageText);
    const hasPending = /Đang chờ/i.test(pageText);
    const hasSentMarker = /Đã gửi bình luận của bạn/i.test(pageText);

    const candidateEls = Array.from(document.querySelectorAll('div, li, ul, article, span'));
    let matchedElement = null;
    let matchedElementText = '';
    let matchedSignature = null;

    for (const el of candidateEls) {
      const raw = (el.innerText || el.textContent || '').trim();
      if (!raw) continue;
      if (raw.length < 20 || raw.length > 2500) continue;
      const norm = normalize(raw);
      const sig = signatures.find(s => norm.includes(normalize(s)));
      const matchesComment = expectedCommentNorm && norm.includes(expectedCommentNorm);
      const mentionsIdentity = /winterfrost|tám lê/i.test(raw);
      if ((matchesComment || sig) && mentionsIdentity) {
        matchedElement = el;
        matchedElementText = raw;
        matchedSignature = sig || null;
        break;
      }
    }

    let localBlockText = '';
    if (matchedElement) {
      let node = matchedElement;
      for (let i = 0; i < 6 && node; i += 1) {
        const raw = (node.innerText || node.textContent || '').trim();
        const norm = normalize(raw);
        if (raw && raw.length >= 20 && raw.length <= 2500 && (norm.includes(expectedCommentNorm) || (matchedSignature && norm.includes(normalize(matchedSignature))))) {
          localBlockText = raw;
          if (/Người bình luận:|Đang chờ|Thích|Trả lời|Chia sẻ|Vừa xong|\d+\s*(phút|giờ|ngày)/i.test(raw)) break;
        }
        node = node.parentElement;
      }
      if (!localBlockText) localBlockText = matchedElementText;
    }

    const localNorm = normalize(localBlockText);
    const localHasOwnComment = !!localNorm && (localNorm.includes(expectedCommentNorm) || !!matchedSignature || /winterfrost/i.test(localBlockText));
    const localHasPending = /Đang chờ/i.test(localBlockText);
    const localHasRejected = /Bị từ chối/i.test(localBlockText);
    const localHasCommenterLabel = /Người bình luận:/i.test(localBlockText);
    const localHasLike = /\bThích\b/i.test(localBlockText);
    const localHasReply = /Trả lời/i.test(localBlockText);
    const localHasShare = /Chia sẻ/i.test(localBlockText);
    const localHasLikeReply = localHasLike && localHasReply;
    const localHasTime = /Vừa xong|\d+\s*(phút|giờ|ngày|tuần|tháng)/i.test(localBlockText);
    const hasWinterFrost = /WinterFrost/i.test(localBlockText || pageText);
    const confirmByMarker = textboxEmpty && hasSentMarker && !hasRejected;
    const confirmByContent = textboxEmpty && localHasOwnComment && !localHasRejected;
    const liveInteractionReady = localHasOwnComment && localHasTime && localHasLikeReply && !localHasPending && !localHasRejected;

    return {
      actionType,
      textboxEmpty,
      hasRejected,
      hasPending,
      hasSentMarker,
      hasWinterFrost,
      hasOwnComment: localHasOwnComment,
      hasCommenterLabel: localHasCommenterLabel,
      hasLikeReplyShareSequence: localHasLikeReply,
      liveInteractionReady,
      matchedOwnComment: localHasOwnComment ? localBlockText.slice(0, 1200) : null,
      matchedSignature,
      confirmByMarker,
      confirmByContent,
      localBlockFound: !!localBlockText,
      localHasPending,
      localHasRejected,
      localHasCommenterLabel,
      localHasTime,
      localHasLike,
      localHasReply,
      localHasShare,
      localBlockText: localBlockText ? localBlockText.slice(0, 1600) : null,
      ownMatches: (pageText.match(/(?:Tám Lê|WinterFrost)[^\n]{0,420}/gi) || []).slice(0, 5)
    };
  }, { expectedCommentNorm, signatures, actionType: actionType || '' });
}

async function submitCommentText(page, commentText, postUrl) {
  const textbox = page.locator('[role="textbox"][contenteditable="true"]').first();
  if (await textbox.count() === 0) {
    log(`  ⛔ BLOCKED_NO_COMMENT_PERMISSION: ${postUrl}`);
    return { status: 'blocked_no_comment_permission', ok: false, commentText, actionType: null };
  }

  const actionType = await textbox.getAttribute('aria-label');
  await textbox.click();
  await textbox.fill(commentText);
  const content = await textbox.textContent();
  if (!content || !content.trim()) {
    log(`  ⚠️ Text not inserted: ${postUrl}`);
    return { status: 'text_not_inserted', ok: false, commentText, actionType: actionType || null };
  }

  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  const verify = await verifyCommentResult(page, commentText, actionType || '');

  if (verify.hasRejected) {
    log(`  🚫 REJECTED: ${postUrl}`);
    return { status: 'rejected', ok: false, commentText, verify, actionType: actionType || null };
  }
  if (verify.hasPending) {
    log(`  ⏳ PENDING_REVIEW: ${postUrl}`);
    return { status: 'pending_review', ok: false, commentText, verify, actionType: actionType || null };
  }
  if (verify.localBlockFound && (verify.confirmByMarker || verify.confirmByContent) && verify.liveInteractionReady) {
    log(`  💬 SENT_CONFIRMED: ${postUrl}`);
    return { status: 'sent_confirmed', ok: true, commentText, verify, actionType: actionType || null };
  }
  if ((verify.textboxEmpty && verify.localBlockFound && !verify.liveInteractionReady && !verify.localHasPending && !verify.localHasRejected) || (verify.textboxEmpty && !verify.hasRejected)) {
    log(`  ⚠️ SUBMITTED_UNCONFIRMED: ${postUrl}`);
    return { status: 'submitted_unconfirmed', ok: false, commentText, verify, actionType: actionType || null };
  }

  log(`  ⚠️ MAY_NOT_HAVE_SENT: ${postUrl}`);
  return { status: 'may_not_have_sent', ok: false, commentText, verify, actionType: actionType || null };
}

async function commentOnPost(page, post) {
  const chosen = getCommentForGroup(post.groupId);
  const commentText = chosen.commentText;
  const postUrl = post.url;

  updatePostComment(post.id, p => {
    p.comment.attemptCount = Number(p.comment.attemptCount || 0) + 1;
    p.comment.lastAttemptAt = nowIso();
    p.comment.lastCommentText = commentText;
    p.comment.lastResult = {
      phase: 'attempt_started',
      stripLink: chosen.stripLink,
      ruleSource: chosen.ruleSource,
      retriedWithoutLink: false
    };
  });

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);

    let result = await submitCommentText(page, commentText, postUrl);

    if (result.status === 'pending_review' && !chosen.stripLink && /winterfrost\.tech/i.test(commentText)) {
      const noLinkText = stripLinkFromComment(commentText);
      log(`  ↩️ Retry without link for group ${post.groupId}: ${postUrl}`);
      rememberGroupStripLink(post.groupId, {
        postId: post.postId,
        postUrl,
        detectedAt: nowIso(),
        fromStatus: result.status,
        matchedSignature: result.verify?.matchedSignature || null,
        hasCommenterLabel: result.verify?.hasCommenterLabel || false,
        hasPending: result.verify?.hasPending || false
      });
      await page.waitForTimeout(2000);
      result = await submitCommentText(page, noLinkText, postUrl);
      result.retryWithoutLink = true;
      result.originalCommentText = commentText;
      result.commentText = noLinkText;
      result.suspectedReason = 'link_block_or_group_comment_review';
    }

    return result;
  } catch (err) {
    const msg = err.message || String(err);
    const status = /timeout/i.test(msg) ? 'failed_timeout' : 'failed_navigation';
    log(`  ❌ FAIL: ${postUrl} — ${msg}`);
    return { status, ok: false, commentText, error: msg, actionType: null };
  }
}

function persistResult(post, result) {
  const ts = nowIso();
  updatePostComment(post.id, p => {
    p.comment.processingAt = null;
    p.comment.actionType = result.actionType || p.comment.actionType || null;
    p.comment.lastResult = {
      classification: result.status,
      verify: result.verify || null,
      error: result.error || null,
      retryWithoutLink: !!result.retryWithoutLink,
      originalCommentText: result.originalCommentText || null,
      suspectedReason: result.suspectedReason || null,
      at: ts
    };

    if (result.status === 'sent_confirmed') {
      p.comment.status = 'sent_confirmed';
      p.comment.confirmedAt = ts;
      p.comment.markedDoneAt = ts;
      p.comment.nextRetryAt = null;
    } else if (result.status === 'rejected') {
      p.comment.status = 'rejected';
      p.comment.rejectedAt = ts;
      p.comment.markedDoneAt = ts;
      p.comment.nextRetryAt = null;
    } else if (result.status === 'pending_review') {
      if (result.retryWithoutLink) {
        p.comment.status = 'needs_review';
        p.comment.nextRetryAt = null;
        p.comment.markedDoneAt = ts;
      } else {
        const attempts = Number(p.comment.attemptCount || 0);
        if (attempts >= MAX_ATTEMPTS) {
          p.comment.status = 'needs_review';
          p.comment.nextRetryAt = null;
          p.comment.markedDoneAt = ts;
        } else {
          p.comment.status = 'retry_pending';
          p.comment.nextRetryAt = isoAfter(RETRY_DELAY_MS);
        }
      }
    } else if (result.status === 'blocked_no_comment_permission') {
      p.comment.status = 'blocked_no_comment_permission';
      p.comment.markedDoneAt = ts;
      p.comment.nextRetryAt = null;
    } else {
      const attempts = Number(p.comment.attemptCount || 0);
      if (attempts >= MAX_ATTEMPTS) {
        p.comment.status = 'needs_review';
        p.comment.nextRetryAt = null;
        p.comment.markedDoneAt = ts;
      } else {
        p.comment.status = 'retry_pending';
        p.comment.nextRetryAt = isoAfter(RETRY_DELAY_MS);
      }
    }
  });

  if (result.status === 'sent_confirmed' || result.status === 'rejected' || result.status === 'blocked_no_comment_permission') {
    syncLegacyTracking(post.postId, result.status);
  }
}

async function processQueue(page) {
  let processed = 0;
  let sent = 0;
  let rejected = 0;
  let blocked = 0;

  while (true) {
    const post = claimNextPost();
    if (!post) break;

    log(`🧵 Processing: ${post.id} | status=${post.comment?.status || 'new'}`);
    const result = await commentOnPost(page, post);
    persistResult(post, result);

    processed++;
    if (result.status === 'sent_confirmed') sent++;
    if (result.status === 'rejected') rejected++;
    if (result.status === 'blocked_no_comment_permission') blocked++;

    await page.waitForTimeout(3000);
  }

  if (!processed) {
    log('📝 Không có post nào cần comment từ posts-db.json');
    return;
  }

  const db = readDb();
  const remaining = getSortedCandidates(db).length;
  log(`✅ Queue done: processed=${processed} | sent=${sent} | rejected(no-retry)=${rejected} | blocked(no-comment)=${blocked} | remaining=${remaining}`);
}

async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
}

async function main() {
  createLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(143); });

  log('========================================');
  log('FB COMMENTER v4 — posts-db queue + verify + rejected=no-retry');
  log(`Watching DB: ${DB_FILE}`);
  log(`Browser restart every ${BROWSER_RESTART_MS / 60000} min`);
  log('========================================');

  let context = await launchBrowser();
  let browserStart = Date.now();
  let page = context.pages()[0] || await context.newPage();

  log('🔐 Kiểm tra đăng nhập Facebook...');
  let loggedIn = await checkLogin(page);
  while (!loggedIn) {
    log('⚠️ CHƯA ĐĂNG NHẬP! Hãy đăng nhập Facebook trên trình duyệt vừa mở.');
    await waitForEnter('👉 Đăng nhập + xác minh 2FA xong, nhấn ENTER để tiếp tục...');
    loggedIn = await checkLogin(page);
    if (!loggedIn) log('❌ Vẫn chưa đăng nhập. Thử lại...');
  }
  log('✅ Đã đăng nhập Facebook! Bắt đầu comment...');

  let processing = false;
  let pending = false;

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
      await processQueue(page);
    } catch (err) {
      log(`ERROR: ${err.message}`);
    }
    processing = false;
    if (pending) {
      pending = false;
      await onTrigger();
    }
  }

  await onTrigger();

  log('👁️ Watching posts-db.json...');
  let debounce = null;
  fs.watch(DB_FILE, { persistent: true }, evt => {
    if (evt === 'change') {
      if (isWatcherSuppressed()) return;
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (isWatcherSuppressed()) return;
        log('📢 posts-db.json changed!');
        onTrigger();
      }, 2000);
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

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
