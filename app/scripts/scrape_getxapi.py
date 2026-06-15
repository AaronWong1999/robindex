#!/usr/bin/env python3
# GetXAPI scraper — pulls a user's tweets with cursor pagination + strict author validation.
# Usage: GX_KEY=.. USER_ID=1338075202798809089 USERNAME=qinbafrank MAX_PAGES=250 OUT=/tmp/qf_tweets.json python3 scrape_getxapi.py
import os, json, time, email.utils, urllib.parse, subprocess

KEY = os.environ["GX_KEY"]
USER_ID = os.environ.get("USER_ID", "1338075202798809089")
USERNAME = os.environ.get("TARGET_USER", "qinbafrank").lower()
MAX_PAGES = int(os.environ.get("MAX_PAGES", "250"))
OUT = os.environ.get("OUT", "/tmp/qf_tweets.json")
BASE = "https://api.getxapi.com/twitter/user/tweets"


def call(cursor):
    url = f"{BASE}?userId={USER_ID}" + (f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else "")
    for attempt in range(6):
        try:
            r = subprocess.run(
                ["curl", "-s", "--max-time", "45", url, "-H", f"Authorization: Bearer {KEY}"],
                capture_output=True, text=True,
            )
            if not r.stdout.strip():
                print("  empty response, retry", flush=True); time.sleep(2); continue
            return json.loads(r.stdout)
        except Exception as ex:
            print("  err", str(ex)[:80], flush=True); time.sleep(2)
    raise SystemExit("too many retries")


def m(t):
    ca = t.get("createdAt")
    ts, iso = 0, ""
    if ca:
        dt = email.utils.parsedate_to_datetime(ca)
        ts = int(dt.timestamp()); iso = dt.astimezone().isoformat()
    urls = []
    ent = t.get("entities") or {}
    for u in (ent.get("urls") or []):
        urls.append(u.get("expanded_url") or u.get("url"))
    return {
        "id": str(t["id"]), "text": t.get("text") or "",
        "created_at_iso": iso, "created_at_ts": ts,
        "is_retweet": 1 if t.get("retweeted_tweet") else 0,
        "lang": t.get("lang") or "",
        "likes": t.get("likeCount") or 0, "retweets": t.get("retweetCount") or 0,
        "replies": t.get("replyCount") or 0, "quotes": t.get("quoteCount") or 0,
        "views": t.get("viewCount") or 0,
        "urls": [u for u in urls if u], "media": t.get("media") or [],
    }


out, seen, cursor = [], set(), None
wrong = 0
for p in range(MAX_PAGES):
    j = call(cursor)
    tw = j.get("tweets") or []
    added = 0
    for t in tw:
        au = (t.get("author") or {}).get("userName", "")
        if au.lower() != USERNAME:  # strict: never store another account's tweets
            wrong += 1
            continue
        rid = str(t["id"])
        if rid in seen:
            continue
        seen.add(rid); out.append(m(t)); added += 1
    cursor = j.get("next_cursor")
    if p % 10 == 0 or p == MAX_PAGES - 1:
        print(f"page {p+1}/{MAX_PAGES}: +{added} (total {len(out)}, wrong-author {wrong})", flush=True)
        json.dump(out, open(OUT, "w"), ensure_ascii=False)  # checkpoint
    if not j.get("has_more") or not cursor or not tw:
        print("no more pages"); break
    time.sleep(0.3)

json.dump(out, open(OUT, "w"), ensure_ascii=False)
nonrt = sum(1 for t in out if not t["is_retweet"])
print(f"DONE: {len(out)} tweets ({nonrt} non-RT, {wrong} wrong-author skipped) -> {OUT}")
if out:
    print("range:", out[-1]["created_at_iso"][:10], "..", out[0]["created_at_iso"][:10])
