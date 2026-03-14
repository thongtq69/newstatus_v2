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

      function hrefMatchesGroup(href) {
        if (!href) return false;
        const cleaned = cleanUrl(href);
        const m = cleaned.match(/\/groups\/([^/?#]+)/i) || cleaned.match(/[?&]idorvanity=([^&#]+)/i);
        if (!m) return false;
        const gid = decodeURIComponent(m[1] || '').trim().toLowerCase();
        return !!gid && gid === String(groupId).trim().toLowerCase();
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
        const fullText = normalizeText(node.innerText || node.textContent || '');
        if (/Người tham gia ẩn danh/i.test(fullText)) {
          const commentSection = node.querySelector('[aria-label*="bình luận"], [aria-label*="comment"]');
          const anonSpans = [...node.querySelectorAll('span')].filter(s =>
            /Người tham gia ẩn danh/i.test(s.textContent)
          );
          if (anonSpans.length > 0) {
            const anonEl = anonSpans[0];
            if (!commentSection || (anonEl.compareDocumentPosition(commentSection) & Node.DOCUMENT_POSITION_FOLLOWING)) {
              return 'Người tham gia ẩn danh';
            }
          }
        }

        const links = [...node.querySelectorAll('a[href]')];
        for (const a of links) {
          const href = a.getAttribute('href') || '';
          const txt = normalizeText(a.textContent);
          if (!txt || txt.length < 2 || txt.length > 80) continue;
          if (/^Facebook$/i.test(txt)) continue;
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

      function hasShareMarkers(node) {
        const text = normalizeText(node.innerText || node.textContent || '');
        if (/đã chia sẻ với nhóm công khai/i.test(text)) return true;
        const els = [...node.querySelectorAll('div[role="button"], button, [aria-label], span')];
        return els.some(el => {
          const t = normalizeText(el.textContent);
          const a = normalizeText(el.getAttribute && el.getAttribute('aria-label'));
          return /^chia sẻ$/i.test(t) || /^share$/i.test(t) || /gửi nội dung này cho bạn bè hoặc đăng lên trang cá nhân của bạn/i.test(a);
        });
      }

      function findHeaderTimeAnchor(node) {
        const rect = node.getBoundingClientRect();
        const headerBottom = rect.top + Math.min(170, Math.max(110, rect.height * 0.28));
        const anchors = [...node.querySelectorAll('a[href]')].map(a => {
          const href = a.href || a.getAttribute('href') || '';
          const r = a.getBoundingClientRect();
          return {
            el: a,
            href,
            text: normalizeText(a.textContent),
            rect: r,
            pid: postIdFromHref(href)
          };
        }).filter(x => x.rect.top >= rect.top - 4 && x.rect.bottom <= headerBottom + 8);

        const authorAnchor = anchors.find(x => {
          if (!x.text || x.text.length < 2 || x.text.length > 100 || /^Facebook$/i.test(x.text)) return false;
          return x.href.includes('/user/') || /^https:\/\/www\.facebook\.com\/(profile\.php|[A-Za-z0-9.]+)(\?|$)/i.test(x.href);
        });

        const candidates = anchors.filter(x => {
          if (!x.href || x.href.includes('/user/') || x.pid) return false;
          if (x.rect.width > 120 || x.rect.height > 30) return false;
          if (authorAnchor) {
            if (x.rect.top < authorAnchor.rect.top - 6) return false;
            if (Math.abs(x.rect.left - authorAnchor.rect.left) > 120) return false;
          }
          return true;
        }).sort((a, b) => {
          if (!authorAnchor) return a.rect.top - b.rect.top;
          const da = Math.abs(a.rect.top - authorAnchor.rect.bottom) + Math.abs(a.rect.left - authorAnchor.rect.left) * 0.2;
          const db = Math.abs(b.rect.top - authorAnchor.rect.bottom) + Math.abs(b.rect.left - authorAnchor.rect.left) * 0.2;
          return da - db;
        });

        return candidates[0] || null;
      }

      function findCardTime(node) {
        const headerAnchor = findHeaderTimeAnchor(node);
        const fromHeader = normalizeText(headerAnchor && headerAnchor.text);
        const headerMatch = fromHeader.match(/(Vừa xong|\d+\s*(phút|giờ|ngày|tuần|tháng)|hôm qua)/i);
        if (headerMatch) return headerMatch[1];
        return findTimeText(node);
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

      function buildCandidate(item) {
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
          if (!hrefMatchesGroup(href)) continue;
          postId = pid;
          chosenHref = href;
          break;
        }

        if (!postId) {
          const deeper = hrefs.find(href => (href.includes('/photo/?') || href.includes('comment_id=')) && hrefMatchesGroup(href));
          const pid = postIdFromHref(deeper || '');
          if (pid) {
            postId = pid;
            chosenHref = deeper || '';
          }
        }

        const shareMarker = hasShareMarkers(item);
        const headerTimeAnchor = findHeaderTimeAnchor(item);
        if (!postId && !shareMarker && !headerTimeAnchor) return null;

        const author = findAuthor(item);
        const content = findContent(item, author);
        const imageUrls = findImageUrls(item);
        const timeText = findCardTime(item);
        const url = postId ? cleanUrl(buildCanonicalPostUrl(chosenHref, postId) || chosenHref) : '';
        if (!author && !content) return null;

        return {
          item,
          postId: postId || null,
          url,
          author,
          timeText,
          headerTimeHref: headerTimeAnchor ? cleanUrl(headerTimeAnchor.href) : '',
          shareMarker,
          content,
          snippet: content,
          imageUrls,
          imageCount: imageUrls.length,
          top: rect.top,
          bottom: rect.bottom,
          visiblePx,
          scrollY: window.scrollY,
          timeAnchorEl: headerTimeAnchor ? headerTimeAnchor.el : null
        };
      }

      async function tryResolvePostIdViaInteraction(candidate) {
        if (!candidate || candidate.postId || !candidate.item || !candidate.timeAnchorEl) return candidate;
        const target = candidate.timeAnchorEl;
        const wrappers = [
          target,
          target.parentElement,
          target.parentElement && target.parentElement.parentElement,
          target.closest('div')
        ].filter(Boolean);

        for (const el of wrappers) {
          try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
          await sleep(180);
          try { el.focus && el.focus(); } catch {}

          const r = el.getBoundingClientRect();
          const cx = Math.floor(r.left + Math.min(r.width - 2, Math.max(2, r.width / 2)));
          const cy = Math.floor(r.top + Math.min(r.height - 2, Math.max(2, r.height / 2)));

          for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            try {
              if (type.startsWith('pointer')) {
                el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: cx, clientY: cy }));
              } else {
                el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0, clientX: cx, clientY: cy }));
              }
            } catch {}
          }
          try { el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' })); } catch {}
          try { el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' })); } catch {}
          await sleep(650);

          const hrefs = [...candidate.item.querySelectorAll('a[href]')]
            .map(a => a.href || a.getAttribute('href') || '')
            .filter(Boolean);
          for (const href of hrefs) {
            const pid = postIdFromHref(href);
            if (!pid) continue;
            if (!hrefMatchesGroup(href)) continue;
            candidate.postId = pid;
            candidate.url = cleanUrl(buildCanonicalPostUrl(href, pid) || href);
            candidate.interactionResolved = true;
            return candidate;
          }
        }

        return candidate;
      }

      async function collectVisiblePosts() {
        const built = getFeedItems()
          .map(buildCandidate)
          .filter(Boolean)
          .sort((a, b) => a.top - b.top);

        for (const candidate of built) {
          if (!candidate.postId && candidate.timeAnchorEl) {
            await tryResolvePostIdViaInteraction(candidate);
          }
        }

        return built;
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
      const unresolved = new Map();
      const debugSteps = [];
      let staleRounds = 0;
      let firstSeenSeq = 0;

      for (let step = 0; step < 12; step++) {
        const visiblePosts = await collectVisiblePosts();
        const before = byId.size;

        for (const post of visiblePosts) {
          if (post.postId) {
            if (!byId.has(post.postId)) byId.set(post.postId, { ...post, firstSeenSeq: firstSeenSeq++ });
          } else {
            const sig = [post.author || '', post.timeText || '', post.headerTimeHref || '', (post.snippet || '').slice(0, 120)].join('|');
            if (!unresolved.has(sig)) unresolved.set(sig, { ...post, firstSeenSeq: firstSeenSeq++ });
          }
        }

        debugSteps.push({
          step,
          scrollY: window.scrollY,
          visibleCount: visiblePosts.length,
          visiblePostIds: visiblePosts.filter(p => p.postId).map(p => p.postId),
          visibleUnresolved: visiblePosts.filter(p => !p.postId).map(p => ({ author: p.author, timeText: p.timeText, headerTimeHref: p.headerTimeHref })),
          interactionResolvedIds: visiblePosts.filter(p => p.interactionResolved).map(p => p.postId)
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
        .sort((a, b) => a.firstSeenSeq - b.firstSeenSeq)
        .slice(0, limit)
        .map(({ item, timeAnchorEl, top, bottom, visiblePx, scrollY, firstSeenSeq, ...post }) => post);

      const unresolvedCards = [...unresolved.values()]
        .sort((a, b) => a.firstSeenSeq - b.firstSeenSeq)
        .slice(0, limit)
        .map(({ item, timeAnchorEl, top, bottom, visiblePx, scrollY, firstSeenSeq, ...post }) => post);

      return {
        ok: true,
        mode: 'hybrid-anchor-share-time-interaction-v2',
        groupId,
        count: posts.length,
        posts,
        unresolvedCount: unresolved.size,
        unresolvedCards,
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
