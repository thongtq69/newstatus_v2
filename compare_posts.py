#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
from datetime import datetime


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def main():
    ap = argparse.ArgumentParser(description='Compare extracted Facebook group posts with saved state and emit only new posts.')
    ap.add_argument('--group-id', required=True)
    ap.add_argument('--input', required=True, help='Path to extracted posts JSON')
    ap.add_argument('--state-dir', default='state')
    ap.add_argument('--output', required=True, help='Path to write comparison result JSON')
    args = ap.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)
    state_dir = Path(args.state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / f'{args.group_id}.json'

    extracted = load_json(input_path, {"posts": []})
    posts = extracted.get('posts', []) if isinstance(extracted, dict) else []
    prev_state = load_json(state_path, {"knownPostIds": []})
    known = set(prev_state.get('knownPostIds', []))

    new_posts = [p for p in posts if p.get('postId') and p.get('postId') not in known]
    merged = []
    seen = set()
    for p in posts:
      pid = p.get('postId')
      if pid and pid not in seen:
        seen.add(pid)
        merged.append(pid)
    for pid in prev_state.get('knownPostIds', []):
      if pid not in seen:
        merged.append(pid)
    merged = merged[:500]

    new_state = {
        'groupId': args.group_id,
        'updatedAt': datetime.now().isoformat(),
        'knownPostIds': merged,
        'latestSeenPostId': posts[0].get('postId') if posts else prev_state.get('latestSeenPostId')
    }
    state_path.write_text(json.dumps(new_state, ensure_ascii=False, indent=2), encoding='utf-8')

    result = {
        'groupId': args.group_id,
        'checkedAt': datetime.now().isoformat(),
        'totalExtracted': len(posts),
        'newCount': len(new_posts),
        'newPosts': new_posts,
        'statePath': str(state_path.resolve())
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
