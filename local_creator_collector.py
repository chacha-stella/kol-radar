import asyncio
import json
import math
import os
import re
import statistics
import time
from collections import Counter
from datetime import datetime, timezone
from itertools import islice
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "config" / "creator-search.json"
SETTINGS_PATH = ROOT / "config" / "local-settings.json"
OUTPUT_PATH = ROOT / "data" / "recommendations.json"
EMAIL_PATTERN = re.compile(r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)
WORD_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9+#-]{2,}")
STOP_WORDS = {
    "the", "and", "for", "with", "this", "that", "from", "your", "you", "are",
    "our", "new", "how", "best", "video", "videos", "shorts", "official", "channel"
}


def load_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def tier_for(followers):
    if followers >= 300_000:
        return "大型 KOL"
    if followers >= 50_000:
        return "中腰部"
    return "小而美"


def public_email(text):
    match = EMAIL_PATTERN.search(text or "")
    return match.group(0) if match else ""


def keyword_cloud(texts, limit=14):
    counts = Counter()
    for text in texts:
        for word in WORD_PATTERN.findall(text or ""):
            normalized = word.lower()
            if normalized not in STOP_WORDS:
                counts[normalized] += 1
    return [{"term": term, "count": count} for term, count in counts.most_common(limit)]


def safe_average(values):
    clean = [float(value) for value in values if value is not None]
    return round(statistics.mean(clean), 2) if clean else 0


def engagement_rate(posts):
    views = sum(max(int(post.get("views", 0)), 0) for post in posts)
    interactions = sum(max(int(post.get("likes", 0)), 0) + max(int(post.get("comments", 0)), 0) for post in posts)
    if views:
        return round(interactions / views * 100, 2)
    followers = max(int(posts[0].get("followers", 0)), 1) if posts else 1
    return round(interactions / (followers * max(len(posts), 1)) * 100, 2)


def merge_candidate(store, brand, candidate):
    key = f"{candidate['platform']}:{candidate['handle'].lower()}"
    current = store[brand].get(key)
    if current is None or candidate.get("score", 0) > current.get("score", 0):
        store[brand][key] = candidate


def instagram_candidates(config, store, status):
    try:
        import instaloader
        from instaloader import Profile, TopSearchResults
    except ImportError:
        status["instagram"] = "missing_dependency"
        return

    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        save_metadata=False,
        quiet=True,
    )
    settings = load_json(SETTINGS_PATH, {})
    username = settings.get("instagramUsername", "").strip()
    if username:
        try:
            loader.load_session_from_file(username)
        except Exception as error:
            # Instagram often blocks scripted login. Continue with public-only collection.
            status["instagram"] = f"public_only_session_unavailable: {type(error).__name__}"

    per_query = config["settings"].get("perQuery", 4)
    recent_count = config["settings"].get("recentPosts", 6)
    successes = 0

    for brand, brand_config in config["brands"].items():
        for track, queries in brand_config["tracks"].items():
            for query in queries:
                try:
                    results = TopSearchResults(loader.context, query)
                    profiles = list(islice(results.get_profiles(), per_query))
                except Exception:
                    continue
                for found_profile in profiles:
                    try:
                        profile = Profile.from_username(loader.context, found_profile.username)
                        if profile.is_private:
                            continue
                        posts = []
                        for post in islice(profile.get_posts(), recent_count):
                            views = int(post.video_view_count or 0) if post.is_video else 0
                            posts.append({
                                "title": (post.caption or "")[:180],
                                "url": f"https://www.instagram.com/p/{post.shortcode}/",
                                "views": views,
                                "likes": int(post.likes or 0),
                                "comments": int(post.comments or 0),
                                "publishedAt": post.date_utc.replace(tzinfo=timezone.utc).isoformat(),
                                "followers": int(profile.followers or 0),
                            })
                        followers = int(profile.followers or 0)
                        rate = engagement_rate(posts)
                        avg_views = round(safe_average([post["views"] for post in posts]))
                        bio = profile.biography or ""
                        candidate = {
                            "id": f"instagram-{profile.username}",
                            "name": profile.full_name or profile.username,
                            "handle": profile.username,
                            "platform": "Instagram",
                            "track": track,
                            "tier": tier_for(followers),
                            "followers": followers,
                            "avgViews": avg_views,
                            "engagementRate": rate,
                            "email": public_email(bio),
                            "bio": bio,
                            "channelUrl": f"https://www.instagram.com/{profile.username}/",
                            "avatarUrl": profile.profile_pic_url,
                            "recentPosts": posts,
                            "keywords": keyword_cloud([bio] + [post["title"] for post in posts]),
                            "reason": f"Found through '{query}' and matched to {track}.",
                            "score": min(100, round(50 + min(rate, 10) * 3 + math.log10(max(followers, 10)) * 4)),
                            "source": "Instaloader public data",
                        }
                        merge_candidate(store, brand, candidate)
                        successes += 1
                        time.sleep(1.5)
                    except Exception:
                        continue
    if successes:
        status["instagram"] = "success"
    elif status.get("instagram", "").startswith("public_only_session_unavailable"):
        status["instagram"] = status["instagram"]
    else:
        status["instagram"] = "no_results_or_blocked"


def nested(data, *keys, default=None):
    value = data
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return default
        value = value[key]
    return value


async def tiktok_candidates(config, store, status):
    try:
        from TikTokApi import TikTokApi
    except ImportError:
        status["tiktok"] = "missing_dependency"
        return

    settings = load_json(SETTINGS_PATH, {})
    token = settings.get("tiktokMsToken") or os.getenv("TIKTOK_MS_TOKEN") or os.getenv("ms_token")
    if not token:
        status["tiktok"] = "missing_ms_token"
        return

    per_query = config["settings"].get("perQuery", 4)
    recent_count = config["settings"].get("recentPosts", 6)
    successes = 0

    try:
        async with TikTokApi() as api:
            chrome_paths = [
                os.environ.get("PROGRAMFILES", r"C:\\Program Files") + r"\\Google\\Chrome\\Application\\chrome.exe",
                os.environ.get("PROGRAMFILES(X86)", r"C:\\Program Files (x86)") + r"\\Google\\Chrome\\Application\\chrome.exe",
                os.environ.get("LOCALAPPDATA", "") + r"\\Google\\Chrome\\Application\\chrome.exe",
            ]
            chrome_path = next((path for path in chrome_paths if path and Path(path).exists()), None)
            session_options = {"ms_tokens": [token], "num_sessions": 1, "sleep_after": 3, "browser": "chromium"}
            if chrome_path:
                session_options["executable_path"] = chrome_path
            await api.create_sessions(**session_options)
            for brand, brand_config in config["brands"].items():
                for track, queries in brand_config["tracks"].items():
                    for query in queries:
                        try:
                            found_users = []
                            search = getattr(api, "search", None)
                            if search and hasattr(search, "users"):
                                async for user in search.users(query, count=per_query):
                                    found_users.append(user)
                            else:
                                from TikTokApi.api.search import Search
                                async for user in Search(api).users(query, count=per_query):
                                    found_users.append(user)
                        except Exception:
                            continue
                        for user in found_users:
                            try:
                                info = await user.info()
                                user_data = nested(info, "userInfo", "user", default={}) or info.get("user", {})
                                stats = nested(info, "userInfo", "stats", default={}) or info.get("stats", {})
                                handle = user_data.get("uniqueId") or getattr(user, "username", "")
                                if not handle:
                                    continue
                                posts = []
                                async for video in api.user(username=handle).videos(count=recent_count):
                                    raw = video.as_dict
                                    video_stats = raw.get("stats", {})
                                    posts.append({
                                        "title": (raw.get("desc") or "")[:180],
                                        "url": f"https://www.tiktok.com/@{handle}/video/{raw.get('id', '')}",
                                        "views": int(video_stats.get("playCount", 0) or 0),
                                        "likes": int(video_stats.get("diggCount", 0) or 0),
                                        "comments": int(video_stats.get("commentCount", 0) or 0),
                                        "publishedAt": datetime.fromtimestamp(int(raw.get("createTime", 0) or 0), tz=timezone.utc).isoformat(),
                                    })
                                followers = int(stats.get("followerCount", 0) or 0)
                                bio = user_data.get("signature", "") or ""
                                rate = engagement_rate(posts)
                                candidate = {
                                    "id": f"tiktok-{handle}",
                                    "name": user_data.get("nickname") or handle,
                                    "handle": handle,
                                    "platform": "TikTok",
                                    "track": track,
                                    "tier": tier_for(followers),
                                    "followers": followers,
                                    "avgViews": round(safe_average([post["views"] for post in posts])),
                                    "engagementRate": rate,
                                    "email": public_email(bio),
                                    "bio": bio,
                                    "channelUrl": f"https://www.tiktok.com/@{handle}",
                                    "avatarUrl": user_data.get("avatarLarger") or user_data.get("avatarMedium") or "",
                                    "recentPosts": posts,
                                    "keywords": keyword_cloud([bio] + [post["title"] for post in posts]),
                                    "reason": f"Found through '{query}' and matched to {track}.",
                                    "score": min(100, round(50 + min(rate, 10) * 3 + math.log10(max(followers, 10)) * 4)),
                                    "source": "TikTok-Api public data",
                                }
                                merge_candidate(store, brand, candidate)
                                successes += 1
                            except Exception:
                                continue
    except Exception as error:
        status["tiktok"] = f"blocked_or_session_error: {error}"
        return
    status["tiktok"] = "success" if successes else "no_results_or_blocked"


async def main():
    config = load_json(CONFIG_PATH, {})
    existing = load_json(OUTPUT_PATH, {"brands": {"dartsnut": [], "chessnut": []}, "platformStatus": {}})
    store = {brand: {} for brand in config["brands"]}
    for brand in store:
        for candidate in existing.get("brands", {}).get(brand, []):
            if candidate.get("platform") == "YouTube":
                merge_candidate(store, brand, candidate)

    status = dict(existing.get("platformStatus", {}))
    instagram_candidates(config, store, status)
    await tiktok_candidates(config, store, status)

    max_per_brand = config["settings"].get("maxPerBrand", 30)
    brands = {}
    for brand, candidates in store.items():
        brands[brand] = sorted(candidates.values(), key=lambda item: item.get("score", 0), reverse=True)[:max_per_brand]

    now = datetime.now(timezone.utc)
    output = {
        "generatedAt": now.isoformat(),
        "week": f"{now.isocalendar().year} W{now.isocalendar().week:02d}",
        "platformStatus": status,
        "brands": brands,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved creator recommendations to {OUTPUT_PATH}")
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
