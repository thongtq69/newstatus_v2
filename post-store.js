const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'posts-db.json');
const EVENTS_FILE = path.join(DATA_DIR, 'post-events.jsonl');

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      version: 1,
      updatedAt: null,
      stats: { totalPosts: 0, groups: 0, cyclesMerged: 0 },
      posts: {}
    }, null, 2), 'utf8');
  }
}

function readDb() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return {
      version: 1,
      updatedAt: null,
      stats: { totalPosts: 0, groups: 0, cyclesMerged: 0 },
      posts: {}
    };
  }
}

function writeDb(db) {
  ensureStore();
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function appendEvent(event) {
  ensureStore();
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
}

function normalizeText(value) {
  return (value || '').toString().replace(/\s+/g, ' ').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function buildPostKey(groupId, postId) {
  return `${groupId}:${postId}`;
}

function mergeScrapeSummary(summary) {
  const db = readDb();
  const ts = nowIso();
  let touched = 0;
  const seenGroups = new Set();

  for (const result of summary.results || []) {
    if (!result || !result.groupId) continue;
    seenGroups.add(result.groupId);
    if (!result.success || !Array.isArray(result.posts)) continue;

    for (const post of result.posts) {
      if (!post || !post.postId) continue;
      const groupId = result.groupId;
      const postId = String(post.postId);
      const key = buildPostKey(groupId, postId);
      const existing = db.posts[key] || null;

      const record = existing || {
        id: key,
        groupId,
        postId,
        url: post.url || `https://www.facebook.com/groups/${groupId}/posts/${postId}/`,
        author: normalizeText(post.author),
        content: normalizeText(post.content || post.snippet),
        snippet: normalizeText(post.snippet || post.content),
        timeText: normalizeText(post.timeText),
        imageUrls: Array.isArray(post.imageUrls) ? post.imageUrls : [],
        imageCount: Number(post.imageCount || 0),
        scrape: {
          firstSeenAt: ts,
          lastSeenAt: ts,
          seenCount: 0,
          firstCycle: summary.cycle || null,
          lastCycle: summary.cycle || null,
          sourceVersion: summary.version || 'unknown',
          mode: result.mode || null,
          unresolvedCountAtLastSeen: Number(result.unresolvedCount || 0)
        },
        classification: {
          eligible: true,
          reason: 'new_from_scrape',
          matchedKeywords: [],
          priority: 50
        },
        comment: {
          status: 'new',
          attemptCount: 0,
          lastAttemptAt: null,
          lastCommentText: null,
          lastResult: null,
          confirmedAt: null,
          rejectedAt: null,
          markedDoneAt: null
        }
      };

      record.url = post.url || record.url;
      record.author = normalizeText(post.author) || record.author;
      record.content = normalizeText(post.content || post.snippet) || record.content;
      record.snippet = normalizeText(post.snippet || post.content) || record.snippet;
      record.timeText = normalizeText(post.timeText) || record.timeText;
      record.imageUrls = Array.isArray(post.imageUrls) ? post.imageUrls : (record.imageUrls || []);
      record.imageCount = Number(post.imageCount || record.imageUrls.length || 0);
      record.scrape.lastSeenAt = ts;
      record.scrape.seenCount = Number(record.scrape.seenCount || 0) + 1;
      record.scrape.lastCycle = summary.cycle || record.scrape.lastCycle || null;
      record.scrape.sourceVersion = summary.version || record.scrape.sourceVersion || 'unknown';
      record.scrape.mode = result.mode || record.scrape.mode || null;
      record.scrape.unresolvedCountAtLastSeen = Number(result.unresolvedCount || 0);

      if (!existing) {
        appendEvent({ ts, type: 'post_discovered', postKey: key, groupId, postId, cycle: summary.cycle || null });
      } else {
        appendEvent({ ts, type: 'post_seen_again', postKey: key, groupId, postId, cycle: summary.cycle || null });
      }

      db.posts[key] = record;
      touched++;
    }
  }

  db.updatedAt = ts;
  db.stats = db.stats || {};
  db.stats.totalPosts = Object.keys(db.posts).length;
  db.stats.groups = new Set(Object.values(db.posts).map(p => p.groupId)).size;
  db.stats.cyclesMerged = Number(db.stats.cyclesMerged || 0) + 1;
  db.stats.lastMergeTouched = touched;
  db.stats.lastCycle = summary.cycle || null;
  db.stats.lastVersion = summary.version || 'unknown';

  writeDb(db);
  return { totalPosts: db.stats.totalPosts, groups: db.stats.groups, touched, updatedAt: ts };
}

module.exports = {
  DATA_DIR,
  DB_FILE,
  EVENTS_FILE,
  ensureStore,
  readDb,
  writeDb,
  mergeScrapeSummary,
};
