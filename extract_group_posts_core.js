(() => {
  function installFacebookGroupExtractor(globalObj = window) {
    globalObj.__fbGroupExtractor = async function extractFacebookGroupPosts(options = {}) {
      const groupId = (options.groupId || globalObj.__FB_GROUP_ID_OVERRIDE || '').toString().trim() || '553651608918495';
      const limit = Number(options.limit || 5);

      function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      function normalizeText(s) {
        return (s || '').replace(/\s+/g, ' ').trim();
      }

      function cleanUrl(url) {
        try {
          const u = new URL(url, location.origin);
          u.hash = '';
          ['__cft__', '__tn__', 'comment_id', 'reply_comment_id', 'notif_id', 'ref', 'locale', 'idorvanity'].forEach(k => u.searchParams.delete(k));
          return u.toString();
        } catch {
          return url;
        }
      }

      function postIdFromHref(href) {
        if (!href) return null;
        const patterns = [
          /\/groups\/[^/]+\/posts\/(\d+)/i,
          /[?&]story_fbid=(\d+)/i,
          /[?&]set=(?:pcb|gm|pb|g)\.(\d+)/i
        ];
        for (const re of patterns) {
          const m = href.match(re);
          if (m) return m[1];
        }
        return null;
      }

      function buildCanonicalPostUrl(href, postId) {
        if (!postId) return '';
        let gid = groupId;
        if (!gid && href) {
          const m = href.match(/\/groups\/([^/?#]+)/i) || href.match(/[?&]idorvanity=([^&#]+)/i);
          if (m) gid = m[1];
        }
        if (!gid) return '';
        return `https://www.facebook.com/groups/${gid}/posts/${postId}/`;
      }

      function findAuthor(node) {
        // Check for anonymous post first
        const fullText = normalizeText(node.innerText || node.textContent || '');
        if (/Người tham gia ẩn danh/i.test(fullText)) {
          // Only return anonymous if it appears BEFORE the first comment section
          const commentSection = node.querySelector('[aria-label*="bình luận"], [aria-label*="comment"]');
          const anonSpans = [...node.querySelectorAll('span')].filter(s =>
            /Người tham gia ẩn danh/i.test(s.textContent)
          );
          if (anonSpans.length > 0) {
            const anonEl = anonSpans[0];
            // If no comment section, or anon appears before it in DOM order
            if (!commentSection || (anonEl.compareDocumentPosition(commentSection) & Node.DOCUMENT_POSITION_FOLLOWING)) {
              return 'Người tham gia ẩn danh';
            }
          }
        }

        // Find author link — but only from the TOP portion of the card (before comments)
        // Strategy: get all links, but stop once we hit comment-like patterns
        const links = [...node.querySelectorAll('a[href]')];
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const txt = normalizeText(a.textContent);
          if (!txt || txt.length < 2 || txt.length > 80) continue;
          if (/^Facebook$/i.test(txt)) continue;
          // Skip if this link is inside a comment reply area
          const parent = a.closest('[role="article"]');
          if (parent && parent !== node && node.contains(parent)) continue;
          if (href.includes('/user/') || /^\/?(profile\.php|[A-Za-z0-9.]+)(\?|$)/.test(href)) return txt;
        }
        return '';
      }

      function findTimeText(node) {
        const text = normalizeText(node.innerText || node.textContent || '');
        const m = text.match(/(Vừa xong|\d+\s*(phút|giờ|ngày|tuần|tháng)|hôm qua)/i);
        return m ? m[1] : '';
      }

      function cleanSnippet(text, author) {
        if (!text) return '';
        let out = text;
        const garbage = [
          'Facebook', 'Theo dõi', 'Thích', 'Bình luận', 'Chia sẻ',
          'Viết bình luận công khai', 'Viết bình luận', 'Mức độ liên quan nhất',
          'Phù hợp nhất', 'Bài viết mới', 'sắp xếp bảng feed nhóm theo',
          'dưới tên WinterFrost', 'Tất cả cảm xúc:', 'Tác giả'
        ];
        for (const g of garbage) out = out.split(g).join(' ');
        if (author) out = out.replace(author, ' ');
        out = out.replace(/(?:\b[a-zA-ZÀ-ỹ0-9]\b\s*){12,}/g, ' ');
        out = out.replace(/^([·•\-|,;:()\[\]{}+]|ú\s*·\s*)+/i, ' ');
        out = normalizeText(out);
        return out.slice(0, 320);
      }

      function findContent(node, author) {
        return cleanSnippet(normalizeText(node.innerText || node.textContent || ''), author);
      }

      function findImageUrls(node) {
        const urls = new Set();
        node.querySelectorAll('img[src]').forEach(img => {
          const src = img.getAttribute('src') || '';
          if (!src) return;
          if (src.includes('scontent') || src.includes('fbcdn.net')) urls.add(src);
        });
        return [...urls].slice(0, 10);
      }

      function getFeedItems() {
        const feed = document.querySelector('[role="feed"]');
        return feed ? [...feed.children] : [];
      }

      function isNoiseText(text) {
        return !text ||
          text.length < 40 ||
          text.includes('sắp xếp bảng feed nhóm theo') ||
          text.includes('Bạn viết gì đi') ||
          text.includes('Nhóm Công khai') ||
          text === 'Facebook';
      }

      function candidateFromItem(item) {
        const rect = item.getBoundingClientRect();
        const viewportH = window.innerHeight;
        const visiblePx = Math.max(0, Math.min(rect.bottom, viewportH) - Math.max(rect.top, 0));
        const nearViewport = rect.top < viewportH + 520 && rect.bottom > -180;
        if (!nearViewport) return null;
        if (visiblePx < 30 && rect.top > viewportH + 220) return null;

        const virtualBlock = item.querySelector('[data-virtualized]');
        if (virtualBlock && virtualBlock.getAttribute('data-virtualized') === 'true') return null;

        const text = normalizeText(item.innerText || item.textContent || '');
        if (isNoiseText(text)) return null;

        let postId = '';
        let chosenHref = '';
        const hrefs = [...item.querySelectorAll('a[href]')]
          .map(a => a.href || a.getAttribute('href') || '')
          .filter(Boolean);

        for (const href of hrefs) {
          const pid = postIdFromHref(href);
          if (!pid) continue;
          postId = pid;
          chosenHref = href;
          break;
        }

        if (!postId) {
          const deeper = hrefs.find(href => href.includes('/photo/?') || href.includes('comment_id='));
          const pid = postIdFromHref(deeper || '');
          if (pid) {
            postId = pid;
            chosenHref = deeper || '';
          }
        }

        if (!postId) return null;

        const author = findAuthor(item);
        const content = findContent(item, author);
        const imageUrls = findImageUrls(item);
        const timeText = findTimeText(item);
        const url = cleanUrl(buildCanonicalPostUrl(chosenHref, postId) || chosenHref);
        if (!author && !content) return null;

        return {
          postId,
          url,
          author,
          timeText,
          content,
          snippet: content,
          imageUrls,
          imageCount: imageUrls.length,
          top: rect.top,
          bottom: rect.bottom,
          visiblePx,
          scrollY: window.scrollY
        };
      }

      function collectVisiblePosts() {
        return getFeedItems()
          .map(candidateFromItem)
          .filter(Boolean)
          .sort((a, b) => a.top - b.top);
      }

      window.scrollTo(0, 0);
      await sleep(1500);
      const feed = document.querySelector('[role="feed"]');
      if (feed) {
        const feedRect = feed.getBoundingClientRect();
        if (feedRect.top > 120) {
          window.scrollBy(0, Math.max(0, feedRect.top - 120));
          await sleep(1500);
        }
      }

      const byId = new Map();
      const debugSteps = [];
      let staleRounds = 0;

      for (let step = 0; step < 12; step++) {
        const visiblePosts = collectVisiblePosts();
        const before = byId.size;

        for (const post of visiblePosts) {
          if (!byId.has(post.postId)) byId.set(post.postId, post);
        }

        debugSteps.push({
          step,
          scrollY: window.scrollY,
          visibleCount: visiblePosts.length,
          visiblePostIds: visiblePosts.map(p => p.postId)
        });

        if (byId.size >= limit) break;

        if (byId.size === before) staleRounds += 1;
        else staleRounds = 0;

        const last = visiblePosts[visiblePosts.length - 1];
        if (!last) break;

        const delta = Math.max(140, Math.min(900, Math.floor(last.bottom - 140)));
        window.scrollBy(0, delta);
        await sleep(staleRounds >= 2 ? 1800 : 1200);
      }

      const posts = [...byId.values()]
        .sort((a, b) => {
          if (a.scrollY !== b.scrollY) return a.scrollY - b.scrollY;
          return a.top - b.top;
        })
        .slice(0, limit)
        .map(({ top, bottom, visiblePx, scrollY, ...post }) => post);

      return {
        ok: true,
        mode: 'anchor-based-core',
        groupId,
        count: posts.length,
        posts,
        debug: {
          finalScrollY: window.scrollY,
          steps: debugSteps
        }
      };
    };

    return globalObj.__fbGroupExtractor;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { installFacebookGroupExtractor };
  }

  if (typeof window !== 'undefined') {
    installFacebookGroupExtractor(window);
  }
})();
