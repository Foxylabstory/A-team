// The outbox is persisted with the lead. A Telegram outage cannot discard a lead.
export function createNotifier(db, config, fetchImpl = fetch) {
  let busy = false;
  let stopped = false;
  let timer;
  let active = Promise.resolve();
  const configured = Boolean(config.telegramToken && config.telegramChat);

  async function deliverBatch() {
    if (busy || stopped || !configured) return;
    busy = true;
    try {
      for (let i = 0; i < 5 && !stopped; i++) {
        const now = Date.now();
        const job = db.prepare(`UPDATE notifications SET status='processing', attempts=attempts+1,
          next_attempt_at=? WHERE lead_id=(SELECT lead_id FROM notifications
          WHERE status IN ('pending','processing') AND next_attempt_at<=?
          ORDER BY next_attempt_at LIMIT 1) RETURNING lead_id,attempts`).get(now + 10 * 60000, now);
        if (!job) break;
        let failure = null;
        try {
          const payload = {
            chat_id: config.telegramChat,
            text: "🥊 На сайте ANTIPOV TEAM поступила новая заявка.\nПосмотрите её в закрытой странице заявок."
          };
          if (config.siteUrl.startsWith("https://")) {
            payload.reply_markup = { inline_keyboard: [[{ text: "Открыть заявки", url: `${config.siteUrl}/admin/` }]] };
          }
          const response = await fetchImpl(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(10000), redirect: "error"
          });
          const result = await response.json();
          if (!response.ok || result.ok !== true) failure = "telegram_rejected";
        } catch { failure = "telegram_unavailable"; }
        if (failure) {
          db.prepare(`UPDATE notifications SET status=?,last_error=?,next_attempt_at=? WHERE lead_id=?`)
            .run(job.attempts >= 6 ? "failed" : "pending", failure,
              Date.now() + Math.min(3600000, 30000 * 2 ** (job.attempts - 1)), job.lead_id);
        } else {
          db.prepare("UPDATE notifications SET status='sent',last_error=NULL,sent_at=? WHERE lead_id=?").run(Date.now(), job.lead_id);
        }
      }
    } finally { busy = false; }
  }

  function runOnce() { if (busy) return active; active = deliverBatch(); return active; }
  return {
    configured, runOnce,
    start() {
      const tick = () => { runOnce().catch(() => console.error("notification_worker_failed")); };
      timer = setInterval(tick, 15000); timer.unref(); tick();
    },
    async stop() { stopped = true; clearInterval(timer); await active; }
  };
}
