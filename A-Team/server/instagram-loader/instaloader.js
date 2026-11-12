import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { INSTAGRAM_NEWS_LIMIT } from "./instagram.js";

export const INSTALOADER_ERRORS = ["instagram_login_required", "instagram_rate_limited", "instagram_private_profile", "instagram_account_mismatch", "instagram_image_unavailable", "instagram_dependency_missing", "instagram_timeout"];
const script = fileURLToPath(new URL("./instaloader-news.py", import.meta.url));

export async function collectWithInstaloader(config, { run = execFile, signal } = {}) {
  const args = [script, "--account", config.instagramUsername, "--hashtag", config.instagramHashtag,
    "--max-posts", String(config.instagramScanLimit || 100)];
  if (config.instagramSessionFile) args.push("--session-file", config.instagramSessionFile);
  // The child only needs runtime settings; keys for other integrations are not inherited.
  const env = { PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1" };
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    run(config.instagramPython || "python3", args, { env, signal, shell: false, windowsHide: true, timeout: 900000, maxBuffer: 18 * 1024 * 1024 }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { return reject(new Error(error?.code === "ENOENT" ? "instagram_dependency_missing" : "instagram_unavailable")); }
      if (error || value.ok !== true) return reject(new Error(INSTALOADER_ERRORS.includes(value.error) ? value.error : "instagram_unavailable"));
      if (value.schemaVersion !== 1 || value.accountUsername !== config.instagramUsername || value.hashtag !== config.instagramHashtag || !Array.isArray(value.items) || value.items.length > INSTAGRAM_NEWS_LIMIT) return reject(new Error("instagram_unavailable"));
      resolve(value);
    });
  });
}
