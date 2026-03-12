"""
fb_webhook_server.py - Webhook server cho N8N/Make.com
Nhận request từ N8N → điều khiển Chrome qua OpenClaw CDP → trả về post URLs

Run: python fb_webhook_server.py
Port: 8765
"""

import json
import time
import threading
import urllib.request
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

CDP_URL = "http://127.0.0.1:18792"  # OpenClaw Chrome relay CDP port

def get_tab_id():
    """Lấy tab Facebook đang mở trong Chrome"""
    req = urllib.request.urlopen(f"{CDP_URL}/json", timeout=5)
    tabs = json.loads(req.read())
    for tab in tabs:
        if "facebook.com" in tab.get("url", ""):
            return tab["id"]
    return None

def cdp_execute(tab_id, expression):
    """Chạy JavaScript trong Chrome qua CDP HTTP endpoint"""
    # OpenClaw expose CDP qua /cdp endpoint
    payload = json.dumps({
        "tabId": tab_id,
        "expression": expression
    }).encode()
    
    req = urllib.request.Request(
        f"{CDP_URL}/cdp/Runtime.evaluate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        result = json.loads(resp.read())
        return result.get("result", {}).get("value")
    except Exception as e:
        return None

def navigate_and_scrape(group_id, count=5):
    """
    Full flow: navigate → scroll → extract URLs
    Trả về list post URLs
    """
    # Dùng browser tool của OpenClaw thông qua subprocess nếu cần
    # Đây là phiên bản dùng JS injection trực tiếp qua CDP

    extract_js = f"""
    (() => {{
      const groupId = '{group_id}';
      const postIds = new Set();
      document.querySelectorAll(`a[href*="/groups/${{groupId}}/posts/"]`).forEach(a => {{
        const m = a.href.match(/\\/posts\\/(\\d+)/);
        if (m) postIds.add(m[1]);
      }});
      return JSON.stringify([...postIds].slice(0, {count}).map(id =>
        `https://www.facebook.com/groups/${{groupId}}/posts/${{id}}/`
      ));
    }})()
    """
    return extract_js.strip()


class WebhookHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self._json({"status": "ok", "server": "fb-group-monitor"})
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/scrape":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        group_id = body.get("group_id", "").strip()
        count = int(body.get("count", 5))

        if not group_id:
            self._json({"error": "group_id is required"}, 400)
            return

        url = f"https://www.facebook.com/groups/{group_id}/?sorting_setting=CHRONOLOGICAL"
        js_snippet = navigate_and_scrape(group_id, count)

        # Trả về hướng dẫn + JS snippet cho agent thực thi
        self._json({
            "group_id": group_id,
            "count": count,
            "navigate_to": url,
            "extract_js": js_snippet,
            "workflow": [
                f"1. Navigate Chrome to: {url}",
                "2. Wait for DOM load (3-5s)",
                "3. Scroll 3x (2500px each, 1s delay)",
                f"4. Execute extract_js to get {count} URLs",
                "5. Return posts array"
            ]
        })

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        print(f"[{args[0]}] {args[1]} {args[2]}")


def run(port=8765):
    server = HTTPServer(("0.0.0.0", port), WebhookHandler)
    print(f"[fb-group-monitor] Webhook server running on http://0.0.0.0:{port}")
    print(f"[fb-group-monitor] GET  /health | POST /scrape")
    print(f"[fb-group-monitor] N8N/Make -> POST http://localhost:{port}/scrape")
    server.serve_forever()


if __name__ == "__main__":
    run()
