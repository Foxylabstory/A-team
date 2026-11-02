import { mkdirSync, chmodSync, copyFileSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export async function createBackup(db, config, backupDir) {
  const relative = path.relative(config.publicDir, backupDir);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) throw new Error("Резервные копии должны находиться вне public/.");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const filename = path.join(backupDir, `club-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
  await backup(db, filename);
  if (process.platform !== "win32") chmodSync(filename, 0o600);
  const snapshot = new DatabaseSync(filename, { readOnly: true });
  let images;
  try { images = snapshot.prepare("SELECT DISTINCT image FROM news_items WHERE image LIKE '/media/news/%'").all(); }
  finally { snapshot.close(); }
  const mediaDirectory = `${filename}.media`;
  mkdirSync(mediaDirectory, { recursive: true, mode: 0o700 });
  for (const { image } of images) {
    const imageFile = image.slice("/media/news/".length);
    if (!/^[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(imageFile)) throw new Error("Некорректный путь изображения в базе.");
    const target = path.join(mediaDirectory, imageFile);
    copyFileSync(path.join(config.dataDir, "news-images", imageFile), target);
    if (process.platform !== "win32") chmodSync(target, 0o600);
  }
  return { filename, mediaDirectory };
}
