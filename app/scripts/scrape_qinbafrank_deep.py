#!/usr/bin/env python3
# Deep GetXAPI scraper for the FULL lifetime corpus of a user.
# The timeline endpoint (twitter/user/tweets) caps at ~4 months; advanced_search with
# `until:` date windows reaches the whole history. We paginate each window by cursor,
# then jump the window back to the oldest tweet seen, until the account start is reached.
#
# Usage:
#   GX_KEY=.. TARGET_USER=qinbafrank OUT=../data/raw/qinbafrank_tweets_full.json \
#   START_FLOOR=2020-12-01 python3 scrape_qinbafrank_deep.py
import os, json, time, email.utils, urllib.parse, subprocess, datetime

KEY = os.environ["GX_KEY"]
USERNAME = os.environ.get("TARGET_USER", "qinbafrank").lower()
OUT = os.environ.get("OUT", "/tmp/qf_full.json")
FLOOR = os.environ.get("START_FLOOR", "2020-11-01")  # do not search before this date
PAGES_PER_WINDOW = int(os.environ.get("PAGES_PER_WINDOW", "80"))
BASE = "https://api.getxapi.com/twitter/tweet/advanced_search"


def call(q, cursor):
    url = f"{BASE}?q={urllib.parse.quote(q)}&queryType=Latest"
    if cursor:
        url += f"&cursor={urllib.parse.quote(cursor, safe='')}"
    for _ in range(6):
        try:
            r = subprocess.run(
                ["curl", "-s", "--max-time", "45", url, "-H", f"Authorization: Bearer {KEY}"],
                capture_output=True, text=True,
            )
            if not r.stdout.strip():
                time.sleep(2); continue
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


def day_str(ts):
    return datetime.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%d")


out, seen = {}, set()
wrong = 0
calls = 0
until = None  # newest-first; None means "from now"
empty_windows = 0

while True:
    q = f"from:{USERNAME}"
    if until:
        q += f" until:{until}"
    cursor = None
    window_oldest_ts = None
    window_added = 0
    for p in range(PAGES_PER_WINDOW):
        j = call(q, cursor); calls += 1
        tw = j.get("tweets") or []
        for t in tw:
            au = (t.get("author") or {}).get("userName", "")
            if au.lower() != USERNAME:
                wrong += 1
                continue
            rid = str(t["id"])
            rec = m(t)
            if rec["created_at_ts"]:
                if window_oldest_ts is None or rec["created_at_ts"] < window_oldest_ts:
                    window_oldest_ts = rec["created_at_ts"]
            if rid in seen:
                continue
            seen.add(rid); out[rid] = rec; window_added += 1
        cursor = j.get("next_cursor")
        if not j.get("has_more") or not cursor or not tw:
            break
        time.sleep(0.25)

    # Checkpoint each window.
    arr = sorted(out.values(), key=lambda x: x["created_at_ts"], reverse=True)
    json.dump(arr, open(OUT, "w"), ensure_ascii=False)
    win_label = until or "now"
    oldest_label = day_str(window_oldest_ts) if window_oldest_ts else "n/a"
    print(f"window until={win_label}: +{window_added} new (total {len(out)}, calls {calls}, "
          f"wrong {wrong}); oldest seen {oldest_label}", flush=True)

    if window_oldest_ts is None:
        empty_windows += 1
        if empty_windows >= 2:
            print("two consecutive empty windows -> done"); break
        # Step the window back a month and retry.
        if until is None:
            break
        d = datetime.datetime.strptime(until, "%Y-%m-%d") - datetime.timedelta(days=30)
        until = d.strftime("%Y-%m-%d")
    else:
        empty_windows = 0
        new_until = day_str(window_oldest_ts + 86400)  # +1 day to include boundary, dedupe handles overlap
        if until == new_until and window_added == 0:
            # No progress; force back a day.
            d = datetime.datetime.strptime(until, "%Y-%m-%d") - datetime.timedelta(days=1)
            new_until = d.strftime("%Y-%m-%d")
        until = new_until

    if until and until < FLOOR:
        print(f"reached floor {FLOOR} -> done"); break

arr = sorted(out.values(), key=lambda x: x["created_at_ts"], reverse=True)
json.dump(arr, open(OUT, "w"), ensure_ascii=False)
nonrt = sum(1 for t in arr if not t["is_retweet"])
print(f"DONE: {len(arr)} tweets ({nonrt} non-RT, {wrong} wrong-author skipped), {calls} api calls -> {OUT}")
if arr:
    print("range:", arr[-1]["created_at_iso"][:10], "..", arr[0]["created_at_iso"][:10])
