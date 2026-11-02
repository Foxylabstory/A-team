import path from "node:path";
import readline from "node:readline";
import { loadConfig } from "../lib/config.js";
import { openDatabase } from "../lib/database.js";
import { hashPassword, replacePassword } from "../lib/auth.js";
import { createBackup } from "../lib/backup.js";

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) throw new Error("Запустите команду в интерактивном терминале. Пароль не принимается через аргументы или переменные окружения.");
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdout.write(label);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = () => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    function onKey(str, key = {}) {
      if (key.ctrl && key.name === "c") { finish(); reject(new Error("Отменено.")); }
      else if (key.name === "return" || key.name === "enter") { finish(); resolve(input); }
      else if (key.name === "backspace") input = [...input].slice(0, -1).join("");
      else if (str && !key.ctrl && !/[\x00-\x1f\x7f]/.test(str)) input += str;
    }
    process.stdin.on("keypress", onKey);
  });
}

let db;
try {
  const command = process.argv[2];
  const config = loadConfig();
  if (command === "password") {
    const first = await hiddenPrompt("Новый пароль администратора (минимум 14 символов): ");
    const second = await hiddenPrompt("Повторите новый пароль: ");
    if (first !== second) throw new Error("Пароли не совпали.");
    const hash = await hashPassword(first);
    db = openDatabase(config.dbPath);
    replacePassword(db, hash);
    console.log("Пароль установлен. Все прежние сеансы завершены. Войдите на /admin/ заново.");
  } else if (command === "init") {
    db = openDatabase(config.dbPath);
    console.log("База создана. Для первого входа выполните: npm run admin:password");
  } else if (command === "backup") {
    const backupDir = path.resolve(config.root, process.env.BACKUP_DIR || "backups");
    db = openDatabase(config.dbPath);
    const { filename, mediaDirectory } = await createBackup(db, config, backupDir);
    console.log("Резервная копия создана:", filename);
    console.log("Фотографии новостей:", mediaDirectory);
  } else throw new Error("Команды: init, password, backup.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally { db?.close(); }
