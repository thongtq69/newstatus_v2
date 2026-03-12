async () => {
  if (typeof window.__fbGroupExtractor !== 'function') {
    throw new Error('Core extractor is not installed. Load extract_group_posts_core.js first.');
  }
  return await window.__fbGroupExtractor({
    groupId: (window.__FB_GROUP_ID_OVERRIDE || '').toString().trim() || undefined,
    limit: 5,
  });
}
