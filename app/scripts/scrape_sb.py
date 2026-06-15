#!/usr/bin/env python3
# Correct ScrapeBadger scraper (proper cursor encoding). Pulls newest pages first.
# Usage: SB_KEY=.. USERNAME=qinbafrank MAX_PAGES=5 OUT=/tmp/qf_tweets.json python3 scrape_sb.py
import os, json, time, urllib.request, urllib.parse

KEY = os.environ["SB_KEY"]
USERNAME = os.environ.get("USERNAME", "qinbafrank")
MAX_PAGES = int(os.environ.get("MAX_PAGES", "5"))
OUT = os.environ.get("OUT", "/tmp/qf_tweets.json")
BASE = f"https://scrapebadger.com/v1/twitter/users/{USERNAME}/latest_tweets"


def call(cursor):
    url = BASE + ("?cursor=" + urllib.parse.quote(cursor, safe="") if cursor else "")
    req = urllib.request.Request(url, headers={"x-api-key": KEY})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                reset = int(e.headers.get("x-ratelimit-reset", "0") or 0)
                wait = max(2, reset - int(time.time()) + 1) if reset else 15
                print(f"  429, waiting {wait}s", flush=True)
                time.sleep(min(wait, 70))
                continue
            if e.code == 402:
                raise SystemExit("402 out of credits")
            print("  http", e.code, e.read()[:120], flush=True)
            time.sleep(3)
    raise SystemExit("too many retries")


def m(t):
    ca = t.get("created_at")
    ts = 0
    iso = ""
    if ca:
        import email.utils
        dt = email.utils.parsedate_to_datetime(ca)
        ts = int(dt.timestamp()); iso = dt.astimezone().isoformat()
    urls = []
    for u in (t.get("urls") or []):
        urls.append(u if isinstance(u, str) else (u.get("expanded_url") or u.get("url")))
    return {
        "id": str(t["id"]), "text": t.get("full_text") or t.get("text") or "",
        "username": t.get("username"),
        "created_at_iso": iso, "created_at_ts": ts,
        "is_retweet": 1 if (t.get("is_retweet") or t.get("retweeted_status_id")) else 0,
        "lang": t.get("lang") or "",
        "likes": t.get("favorite_count") or 0, "retweets": t.get("retweet_count") or 0,
        "replies": t.get("reply_count") or 0, "quotes": t.get("quote_count") or 0,
        "views": t.get("view_count") or 0,
        "urls": [u for u in urls if u], "media": t.get("media") or [],
    }


out, seen, cursor = [], set(), None
for p in range(MAX_PAGES):
    j = call(cursor)
    tw = j.get("data") or []
    # guard: only keep tweets actually authored by the target user
    added = 0
    for t in tw:
        if (t.get("username") or "").lower() != USERNAME.lower():
            continue
        rid = str(t["id"])
        if rid in seen:
            continue
        seen.add(rid); out.append(m(t)); added += 1
    cursor = j.get("next_cursor")
    print(f"page {p+1}/{MAX_PAGES}: +{added} (total {len(out)})", flush=True)
    if not cursor or not tw:
        print("no more pages"); break
    time.sleep(1)

json.dump(out, open(OUT, "w"), ensure_ascii=False)
nonrt = sum(1 for t in out if not t["is_retweet"])
print(f"DONE: {len(out)} tweets ({nonrt} non-RT) -> {OUT}")
if out:
    print("range:", out[-1]["created_at_iso"][:10], "..", out[0]["created_at_iso"][:10])
