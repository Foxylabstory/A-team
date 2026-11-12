import importlib.util
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("club_news", Path(__file__).parents[1] / "instagram-loader" / "instaloader-news.py")
news = importlib.util.module_from_spec(spec)
spec.loader.exec_module(news)
PNG = b"\x89PNG\r\n\x1a\n" + b"test-image-bytes"


class ImageResponse:
    status_code = 200
    headers = {"Content-Length": str(len(PNG))}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def iter_content(self, _):
        yield PNG


class ImageSession:
    urls = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def get(self, url, **options):
        assert options["allow_redirects"] is False
        self.urls.append(url)
        return ImageResponse()


class LoginRequired(Exception):
    pass


class BadCredentials(Exception):
    pass


class TooManyRequests(Exception):
    pass


class Loader:
    def __init__(self, **_):
        self.context = object()

    def close(self):
        pass


class NewsTests(unittest.TestCase):
    def collect(self, posts, private=False, limit=100):
        profile = SimpleNamespace(username="antipov__team", is_private=private, get_posts=lambda: iter(posts))
        library = SimpleNamespace(Instaloader=Loader, InstaloaderException=Exception, Profile=SimpleNamespace(from_username=lambda *_: profile),
            LoginRequiredException=LoginRequired, BadCredentialsException=BadCredentials, TooManyRequestsException=TooManyRequests)
        with patch.dict("sys.modules", {"instaloader": library, "requests": SimpleNamespace(Session=ImageSession)}):
            return news.collect("antipov__team", "новости", limit)

    def test_exact_tag_six_newest_and_local_cover_payload(self):
        posts = [SimpleNamespace(mediaid=i, caption=f"Событие {i}\n#НоВоСтИ", shortcode=f"code{i}",
            date_utc=datetime(2026, 10, i), url=f"https://scontent.cdninstagram.com/{i}.png", is_video=False, typename="GraphImage") for i in (1, 7, 2, 6, 3, 5, 4)]
        posts.insert(1, SimpleNamespace(caption="Без новости #новостиспорта"))
        result = self.collect(posts)
        self.assertEqual([item["id"] for item in result["items"]], ["7", "6", "5"])
        self.assertEqual(result["scanned"], 8)
        self.assertFalse(result["truncated"])
        self.assertTrue(all(item["image"]["type"] == "image/png" for item in result["items"]))
        self.assertTrue(all("imageUrl" not in item for item in result["items"]))

    def test_private_profile_is_rejected_even_if_a_session_could_read_it(self):
        with self.assertRaisesRegex(news.NewsError, "instagram_private_profile"):
            self.collect([], private=True)

    def test_video_and_first_video_in_a_carousel(self):
        self.assertEqual(news.video_url(SimpleNamespace(is_video=True, video_url="https://scontent.cdninstagram.com/clip.mp4")), "https://scontent.cdninstagram.com/clip.mp4")
        sidecar = SimpleNamespace(is_video=False, typename="GraphSidecar", get_sidecar_nodes=lambda: iter([
            SimpleNamespace(is_video=False), SimpleNamespace(is_video=True, video_url="https://scontent.cdninstagram.com/first.mp4"), SimpleNamespace(is_video=True, video_url="https://scontent.cdninstagram.com/second.mp4")]))
        self.assertEqual(news.video_url(sidecar), "https://scontent.cdninstagram.com/first.mp4")

    def test_scan_limit_and_empty_tags_do_not_fabricate_news(self):
        result = self.collect([SimpleNamespace(caption="Обычная публикация") for _ in range(5)], limit=2)
        self.assertEqual(result["items"], [])
        self.assertEqual(result["scanned"], 2)
        self.assertTrue(result["truncated"])

    def test_image_host_redirect_format_and_size_limits(self):
        for url in ("http://scontent.cdninstagram.com/a.png", "https://cdninstagram.com.evil.test/a.png", "https://127.0.0.1/a.png", "https://user:secret@cdninstagram.com/a.png"):
            with self.assertRaises(news.NewsError):
                news.read_image(url, ImageSession(), lambda: None)
        with self.assertRaises(news.NewsError):
            news.validate_image(b"<svg>script</svg>")
        with self.assertRaises(news.NewsError):
            news.validate_image(PNG + b"x" * news.IMAGE_LIMIT)

    def test_session_is_plain_validated_json_without_pickle_execution(self):
        with tempfile.TemporaryDirectory(prefix="antipov-session-test-") as directory:
            filename = Path(directory) / "session.json"
            filename.write_text(json.dumps({"schemaVersion": 1, "username": "my_account", "cookies": {"sessionid": "test-only"}}))
            seen = []
            loader = SimpleNamespace(context=SimpleNamespace(load_session=lambda user, cookies: seen.append((user, cookies))))
            news.load_session(loader, str(filename))
            self.assertEqual(seen[0][0], "my_account")
            filename.write_text(json.dumps({"schemaVersion": 1, "username": "my_account", "cookies": {"sessionid": 123}}))
            with self.assertRaises(news.NewsError):
                news.load_session(loader, str(filename))


if __name__ == "__main__":
    unittest.main()
