"""Read one public profile. stdout contains only the news protocol, never a session."""
import argparse
import base64
import contextlib
from datetime import timezone
import json
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
from urllib.parse import urlparse

IMAGE_LIMIT = 2 * 1024 * 1024
STAGE = "setup"


class NewsError(Exception):
    pass


def validate_image(data):
    if not 12 <= len(data) <= IMAGE_LIMIT:
        raise NewsError("instagram_image_unavailable")
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff") and data.endswith(b"\xff\xd9"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    raise NewsError("instagram_image_unavailable")


def read_image(url, session, check_deadline):
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in (None, 443) or not any(
        host == domain or host.endswith("." + domain) for domain in ("cdninstagram.com", "fbcdn.net")
    ):
        raise NewsError("instagram_image_unavailable")
    check_deadline()
    # Use a separate anonymous session: Instagram login cookies are never sent to image hosts.
    with session.get(url, stream=True, timeout=(5, 15), allow_redirects=False) as response:
        if response.status_code != 200 or int(response.headers.get("Content-Length", "0")) > IMAGE_LIMIT:
            raise NewsError("instagram_image_unavailable")
        data = bytearray()
        for chunk in response.iter_content(65536):
            check_deadline()
            data.extend(chunk)
            if len(data) > IMAGE_LIMIT:
                raise NewsError("instagram_image_unavailable")
    raw = bytes(data)
    return {"type": validate_image(raw), "data": base64.b64encode(raw).decode("ascii")}


def load_session(loader, filename):
    value = json.loads(Path(filename).read_text(encoding="utf-8"))
    cookies = value.get("cookies")
    if value.get("schemaVersion") != 1 or not re.fullmatch(r"[a-zA-Z0-9._]{1,30}", value.get("username", "")) or not isinstance(cookies, dict) or not 1 <= len(cookies) <= 50:
        raise NewsError("instagram_login_required")
    if any(not isinstance(k, str) or not isinstance(v, str) or len(k) > 100 or len(v) > 16384 for k, v in cookies.items()):
        raise NewsError("instagram_login_required")
    loader.context.load_session(value["username"], cookies)


def video_url(post):
    if post.is_video:
        return post.video_url or ""
    if post.typename == "GraphSidecar":
        return next((node.video_url for node in post.get_sidecar_nodes() if node.is_video and node.video_url), "")
    return ""


def collect(account, hashtag, max_posts, session_file=""):
    global STAGE
    try:
        import instaloader
        import requests
    except ImportError:
        raise NewsError("instagram_dependency_missing") from None
    deadline = time.monotonic() + 850

    def check_deadline():
        if time.monotonic() >= deadline:
            raise NewsError("instagram_timeout")

    pattern = re.compile(r"(?<!\w)#" + re.escape(hashtag) + r"(?!\w)", re.IGNORECASE)
    loader = instaloader.Instaloader(quiet=True, max_connection_attempts=1, request_timeout=15, iphone_support=False)
    try:
        if session_file:
            load_session(loader, session_file)
        STAGE = "profile"
        profile = instaloader.Profile.from_username(loader.context, account)
        if profile.username.casefold() != account.casefold():
            raise NewsError("instagram_account_mismatch")
        if profile.is_private:
            raise NewsError("instagram_private_profile")
        records = {}
        scanned = 0
        STAGE = "posts"
        for post in profile.get_posts():
            check_deadline()
            scanned += 1
            caption = unicodedata.normalize("NFKC", post.caption or "")
            if pattern.search(caption):
                if len(caption) > 10000 or not str(post.mediaid).isdigit():
                    raise NewsError("instagram_unavailable")
                unavailable = False
                try:
                    video_address = video_url(post)
                except instaloader.InstaloaderException:
                    video_address, unavailable = "", True
                records[str(post.mediaid)] = {"id": str(post.mediaid), "caption": caption,
                    "timestamp": post.date_utc.replace(tzinfo=timezone.utc).isoformat(),
                    "link": "https://www.instagram.com/p/" + post.shortcode + "/", "imageUrl": post.url, "videoUrl": video_address, "videoUnavailable": unavailable}
            if scanned >= max_posts:
                break
        selected = sorted(records.values(), key=lambda item: item["timestamp"], reverse=True)[:6]
        STAGE = "images"
        with requests.Session() as images:
            for item in selected:
                item["image"] = read_image(item.pop("imageUrl"), images, check_deadline)
        return {"schemaVersion": 1, "hashtag": hashtag, "accountUsername": profile.username.lower(),
                "items": selected, "scanned": scanned, "scanLimit": max_posts, "truncated": scanned >= max_posts}
    except (instaloader.LoginRequiredException, instaloader.BadCredentialsException):
        raise NewsError("instagram_login_required") from None
    except instaloader.TooManyRequestsException:
        raise NewsError("instagram_rate_limited") from None
    finally:
        loader.close()


def login(filename):
    import instaloader
    username = input("Имя своего аккаунта Instagram: ").strip().lstrip("@")
    if not re.fullmatch(r"[a-zA-Z0-9._]{1,30}", username):
        raise NewsError("invalid_username")
    print("Сессия даёт доступ к аккаунту Instagram. Она будет сохранена только в закрытом файле загрузчика.")
    loader = instaloader.Instaloader(quiet=True, max_connection_attempts=1, request_timeout=20)
    try:
        loader.interactive_login(username)
        value = {"schemaVersion": 1, "username": username, "cookies": loader.context.save_session()}
        target = Path(filename)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = target.with_suffix(".tmp")
        with open(temporary, "w", encoding="utf-8", opener=lambda name, flags: os.open(name, flags, 0o600)) as output:
            json.dump(value, output)
        os.replace(temporary, target)
        print("Сессия сохранена. Пароль в файл не записывается.")
    finally:
        loader.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--account", default="antipov__team")
    parser.add_argument("--hashtag", default="новости")
    parser.add_argument("--max-posts", type=int, default=100)
    parser.add_argument("--session-file", default="")
    parser.add_argument("--login", action="store_true")
    args = parser.parse_args()
    if args.login:
        if not args.session_file:
            parser.error("--session-file is required for login")
        login(args.session_file)
        return
    if not re.fullmatch(r"[a-zA-Z0-9._]{1,30}", args.account) or not re.fullmatch(r"\w{1,80}", args.hashtag) or not 1 <= args.max_posts <= 500:
        parser.error("Invalid account, hashtag or scan limit")
    try:
        # Library diagnostics can contain URLs or account details; never put them in the feed.
        with open(os.devnull, "w") as diagnostics, contextlib.redirect_stdout(diagnostics), contextlib.redirect_stderr(diagnostics):
            value = collect(args.account, args.hashtag, args.max_posts, args.session_file)
        print(json.dumps({"ok": True, **value}, ensure_ascii=False))
    except Exception as error:
        code = str(error) if isinstance(error, NewsError) else "instagram_unavailable"
        print(json.dumps({"ok": False, "error": code, "stage": STAGE, "errorType": type(error).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main()
