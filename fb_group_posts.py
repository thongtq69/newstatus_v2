#!/usr/bin/env python3
"""
fb_group_posts.py - Webhook server for Facebook group post scraping
Receives requests from N8N/Make, triggers browser automation via OpenClaw, returns post URLs.

Usage:
  python fb_group_posts.py [--port 8765]

N8N/Make calls:
  POST http://localhost:8765/scrape
  Body: {"group_id": "852586990732832", "count": 5}

Returns:
  {"posts": ["https://www.facebook.com/groups/.../posts/.../", ...]}
"""

import json
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

# JS snippet to extract post URLs from the current page
EXTRACT_JS = """
(() => {{
  const groupId = '{group_id}';
  const postIds = new Set();
  document.querySelectorAll(`a[href*="/groups/${{groupId}}/posts/"]`).forEach(a => {{
    const m = a.href.match(/\\/posts\\/(\\d+)/);
    if (m) postIds.add(m[1]);
  }});
  return [...postIds].slice(0, {count}).map(id =>
    `https://www.facebook.com/groups/${{groupId}}/posts/${{id}}/`
  );
}})()
"""


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/scrape':
            self.send_error(404)
            return

        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))
        group_id = body.get('group_id', '')
        count = int(body.get('count', 5))

        if not group_id:
            self.send_error(400, 'group_id required')
            return

        # This script just returns the JS and URL for the AI/Clawd to execute
        # In production, you'd integrate with OpenClaw API or Playwright directly
        result = {
            "navigate_to": f"https://www.facebook.com/groups/{group_id}/?sorting_setting=CHRONOLOGICAL",
            "extract_js": EXTRACT_JS.format(group_id=group_id, count=count),
            "instructions": [
                f"1. Navigate to: https://www.facebook.com/groups/{group_id}/?sorting_setting=CHRONOLOGICAL",
                "2. Wait for page load",
                "3. Scroll down 2-3 times (2500px each)",
                f"4. Run extract_js to get {count} post URLs",
                "5. Return the URL list"
            ]
        }

        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode())

    def log_message(self, format, *args):
        pass  # suppress logs


def main():
    port = 8765
    if '--port' in sys.argv:
        port = int(sys.argv[sys.argv.index('--port') + 1])
    print(f"fb_group_posts webhook server running on port {port}")
    HTTPServer(('0.0.0.0', port), Handler).serve_forever()


if __name__ == '__main__':
    main()
