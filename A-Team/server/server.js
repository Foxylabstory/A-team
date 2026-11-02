import { createApplication } from "./lib/app.js";
import { loadConfig } from "./lib/config.js";

const config = loadConfig();
const application = createApplication(config);
const server = application.app.listen(config.port, config.host, () => {
  console.log(`ANTIPOV TEAM → http://${config.host}:${config.port}`);
  console.log("Заявки администратора: /admin/");
  if (!application.db.prepare("SELECT id FROM admin WHERE id=1").get()) {
    console.log("Задайте первый пароль командой: npm run admin:password");
  }
  if (!application.notifier.configured) console.log("Telegram не настроен. Заявки сохраняются в базе.");
  application.notifier.start();
});
server.on("error", async (error) => {
  console.error("Не удалось запустить сервер:", error.code || error.name);
  await application.close();
  process.exitCode = 1;
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await application.close(); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
