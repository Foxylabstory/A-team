const $ = id => document.getElementById(id);
const statuses = { new: "Новая", contacted: "Связались", booked: "Записан", closed: "Закрыта" };
const events = { admin_created: "Создан доступ администратора", password_changed_all_sessions_revoked: "Пароль изменён, все сеансы завершены",
  login_success: "Вход в кабинет", login_failed: "Неудачная попытка входа", logout: "Выход из кабинета",
  lead_created: "Поступила заявка", lead_status_changed: "Изменён статус заявки", lead_deleted: "Заявка удалена",
  leads_viewed: "Просмотрены заявки", notification_retried: "Повтор уведомления", retention_cleanup: "Удалены заявки по сроку хранения",
  news_created: "Опубликована ручная новость", news_edited: "Новость отредактирована", news_deleted: "Ручная новость удалена",
  news_hidden: "Новость скрыта с сайта", news_restored: "Новость возвращена на сайт", news_instagram_imported: "Загружены новости Instagram" };
let csrfToken = "";
let page = 1;
let currentTab = "leads";
let notificationsConfigured = false;
let loading = false;
let newsPage = 1;
let newsLoading = false;
let newsImporting = false;
let newsWatchingImport = false;
let newsConfigured = false;
let newsRunning = false;
let editedNews = null;
let previewUrl = "";

function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
}
function signedOut(text = "") {
  csrfToken = "";
  newsWatchingImport = false;
  $("leads").replaceChildren();
  $("audit-list").replaceChildren();
  $("news-list").replaceChildren();
  closeNewsEditor();
  $("dashboard").hidden = true;
  $("login-view").hidden = false;
  $("password-form").reset();
  $("login-form").reset();
  message(text);
}
async function api(url, { method = "GET", body, keepLogin = false } = {}) {
  const headers = {};
  if (method !== "GET") { headers["Content-Type"] = "application/json"; headers["X-CSRF-Token"] = csrfToken; }
  const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    const errors = { too_many: "Слишком много попыток. Подождите перед повтором.", setup_required: "Пароль ещё не задан. Владельцу сервера нужно выполнить npm run admin:password.",
      invalid_password: "Пароль неверен.", weak_password: "Новый пароль должен содержать минимум 14 символов и не более 256 байт.",
      same_password: "Новый пароль должен отличаться от текущего.", unauthorized: "Сеанс завершён. Войдите заново.",
      csrf: "Обновите страницу и повторите действие.", credentials_changed: "Доступ изменился. Войдите заново.",
      notifications_not_configured: "Сначала настройте Telegram на сервере.",
      invalid_news: "Укажите заголовок до 120 символов и текст до 2000 символов.", invalid_date: "Проверьте дату публикации.",
      invalid_image: "Выберите настоящее изображение JPEG, PNG или WebP размером до 2 МБ.",
      instagram_not_configured: "Загрузка Instagram ещё не подключена на сервере. Ручные новости доступны.",
      instagram_auth: "Instagram отклонил доступ. Нужно обновить токен или разрешение на чтение публикаций. Сохранённые новости остались на сайте.",
      instagram_account_mismatch: "Подключён другой аккаунт Instagram. Проверьте настройки загрузчика. Сохранённые новости остались на сайте.",
      instagram_login_required: "Instagram потребовал вход. На загрузчике нужно подключить или обновить сохранённую сессию Instagram.",
      instagram_rate_limited: "Instagram временно ограничил запросы. Повторная проверка выполнится позже; сохранённые новости остались на сайте.",
      instagram_private_profile: "Аккаунт закрыт. Загрузчик настроен на открытые публикации клуба.",
      instagram_dependency_missing: "На загрузчике нужно установить Python и Instaloader.",
      instagram_image_unavailable: "Не удалось скопировать обложку публикации. Сохранённые новости остались на сайте.",
      instagram_timeout: "Instagram не успел ответить. Повторная проверка выполнится позже; сохранённые новости остались на сайте.",
      import_busy: "Загрузка из Instagram уже выполняется. Дождитесь завершения.",
      instagram_unavailable: "Не удалось загрузить Instagram. Проверьте подключение загрузчика и доступ к аккаунту. Сохранённые новости остались на сайте.",
      instagram_readonly: "Текст публикации Instagram обновляется при импорте. Её можно скрыть с сайта." };
    const text = errors[data.error] || "Не удалось выполнить действие. Попробуйте ещё раз.";
    if (response.status === 401 && !keepLogin) signedOut(text);
    throw new Error(text);
  }
  return data;
}
async function enter() {
  const session = await api("/api/admin/session");
  csrfToken = session.csrfToken;
  notificationsConfigured = session.notificationsConfigured;
  $("notification-hint").hidden = notificationsConfigured;
  $("notification-hint").textContent = "Telegram пока не настроен. Все заявки сохраняются здесь; уведомления ожидают настройки.";
  $("retention-hint").textContent = `Срок хранения заявок в рабочей базе: ${session.retentionDays} дней. Срок задаётся владельцем сервера.`;
  $("login-view").hidden = true;
  $("dashboard").hidden = false;
  $("login-form").reset();
  page = 1;
  $("status-filter").value = "all";
  newsPage = 1;
  $("news-filter").value = "all";
  await selectTab("leads");
}
async function selectTab(tab) {
  currentTab = tab;
  message("");
  document.querySelectorAll("[data-tab]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.tab === tab)));
  for (const name of ["leads", "news", "password", "audit"]) $(`${name}-panel`).hidden = name !== tab;
  $("dashboard-title").textContent = tab === "news" ? "Новости клуба" : "Заявки на тренировку";
  $("dashboard-description").textContent = tab === "news" ? "Публикации и управление лентой сайта." : "Контакты остаются в закрытом кабинете клуба.";
  if (tab === "leads") await loadLeads();
  if (tab === "news") await loadNews();
  if (tab === "audit") await loadAudit();
}
function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function date(value) { return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" }).format(new Date(value)); }
function leadCard(lead) {
  const card = element("article", undefined, "card lead");
  const contact = element("div");
  contact.append(element("h2", lead.name, "lead-name"));
  const phone = element("a", lead.phone, "lead-phone");
  phone.href = `tel:${lead.phone.replace(/[^+\d]/g, "")}`;
  contact.append(phone, element("div", `${date(lead.created_at)} · МСК`, "lead-date"));
  const control = element("div");
  const label = element("label", "Статус");
  label.htmlFor = `status-${lead.id}`;
  const select = element("select"); select.id = label.htmlFor;
  for (const [value, text] of Object.entries(statuses)) { const option = element("option", text); option.value = value; select.append(option); }
  select.value = lead.status;
  select.addEventListener("change", async () => {
    select.disabled = true;
    try { await api(`/api/admin/leads/${lead.id}`, { method: "PATCH", body: { status: select.value } }); message("Статус сохранён."); await loadLeads(); }
    catch (error) { select.value = lead.status; message(error.message, true); }
    finally { select.disabled = false; }
  });
  control.append(label, select);
  const labels = { sent: "Уведомление отправлено", pending: notificationsConfigured ? "Уведомление в очереди" : "Уведомление ожидает настройки", processing: "Отправляем уведомление", failed: "Уведомление не доставлено" };
  const notification = element("div", labels[lead.notification_status] || "Без уведомления", "notification");
  if (lead.notification_status === "failed" && notificationsConfigured) {
    const retry = element("button", "Повторить уведомление"); retry.type = "button";
    retry.addEventListener("click", async () => {
      retry.disabled = true;
      try { await api(`/api/admin/leads/${lead.id}/notify`, { method: "POST", body: {} }); await loadLeads(); }
      catch (error) { message(error.message, true); retry.disabled = false; }
    });
    notification.append(retry);
  }
  const remove = element("button", "Удалить", "delete danger"); remove.type = "button";
  remove.addEventListener("click", async () => {
    const dialog = $("delete-dialog");
    dialog.returnValue = "cancel";
    dialog.showModal();
    dialog.addEventListener("close", async () => {
      if (dialog.returnValue !== "delete") return;
      remove.disabled = true;
      try { await api(`/api/admin/leads/${lead.id}`, { method: "DELETE", body: {} }); message("Заявка удалена."); await loadLeads(); }
      catch (error) { message(error.message, true); remove.disabled = false; }
    }, { once: true });
  });
  const details = element("details", undefined, "details");
  details.append(element("summary", "Согласие на обработку данных"), element("p", lead.consent_text),
    element("p", `Получено: ${date(lead.consent_at)} МСК · Версия: ${lead.consent_version}`));
  card.append(contact, control, notification, remove, details);
  return card;
}
async function loadLeads() {
  if (loading || !csrfToken) return;
  loading = true;
  $("refresh").disabled = true;
  const requestedFilter = $("status-filter").value;
  const requestedPage = page;
  try {
    const data = await api(`/api/admin/leads?status=${encodeURIComponent(requestedFilter)}&page=${requestedPage}`);
    if (!csrfToken) return;
    if (requestedFilter !== $("status-filter").value || requestedPage !== page) return;
    if (!data.items.length && page > 1) { page--; return; }
    $("leads").replaceChildren(...data.items.map(leadCard));
    if (!data.items.length) $("leads").append(element("div", requestedFilter === "all" ? "Заявок пока нет. Новые обращения появятся здесь." : "Заявок с этим статусом нет. Выберите другой статус или все заявки.", "empty"));
    $("summary").textContent = `Заявок: ${data.total} · Обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
    $("page-label").textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
    $("previous").disabled = data.page <= 1;
    $("next").disabled = data.page * data.pageSize >= data.total;
  } finally {
    loading = false;
    $("refresh").disabled = false;
    if (csrfToken && (requestedFilter !== $("status-filter").value || requestedPage !== page)) await loadLeads();
  }
}
function closeNewsEditor() {
  editedNews = null;
  $("news-form").reset();
  $("news-editor").hidden = true;
  $("news-image-preview").hidden = true;
  $("news-image-preview").removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = "";
}
function openNewsEditor(item = null) {
  closeNewsEditor();
  editedNews = item;
  const form = $("news-form");
  form.elements.title.value = item?.title || "";
  form.elements.text.value = item?.text || "";
  const currentDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  form.elements.date.value = /^\d{4}-\d{2}-\d{2}$/.test(item?.display_date || "") ? item.display_date : currentDate;
  if (item?.image?.startsWith("/media/news/")) { $("news-image-preview").src = item.image; $("news-image-preview").hidden = false; }
  $("news-editor-title").textContent = item ? "Редактировать новость" : "Новая публикация";
  $("save-news").textContent = item ? "Сохранить изменения" : "Опубликовать новость";
  $("news-editor").hidden = false;
  $("news-editor").scrollIntoView({ behavior: "smooth", block: "start" });
  form.elements.title.focus({ preventScroll: true });
}
function newsCard(item) {
  const card = element("article", undefined, `card news-card${item.hidden ? " hidden-news" : ""}`);
  if (item.image?.startsWith("/media/news/")) {
    const image = element("img", undefined, "news-cover"); image.src = item.image; image.alt = ""; image.loading = "lazy";
    card.append(image);
  } else card.append(element("div", "Без фотографии", "news-cover news-placeholder"));
  const body = element("div");
  const source = item.source === "instagram" ? "Instagram" : "Ручная публикация";
  body.append(element("div", `${source} · ${item.display_date}${item.hidden ? " · Скрыта с сайта" : ""}`, "news-meta"),
    element("h2", item.title), element("p", item.text, "news-body"));
  if (item.has_video) body.append(element("p", item.video ? "Видео сохранено для актуальной новости." : item.video_error === "video_too_large"
    ? "Видео превышает 100 МБ. На сайте показывается обложка." : item.video_error ? "Видео не удалось загрузить. На сайте показывается обложка."
      : "Видео хранится только для трёх актуальных новостей; при возвращении записи загрузчик попробует получить ролик повторно.", "muted"));
  const actions = element("div", undefined, "actions");
  if (item.source === "manual") {
    const edit = element("button", "Редактировать"); edit.type = "button";
    edit.addEventListener("click", () => openNewsEditor(item)); actions.append(edit);
  }
  if (item.hidden) {
    const restore = element("button", "Вернуть на сайт"); restore.type = "button";
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      try { await api(`/api/admin/news/${encodeURIComponent(item.id)}`, { method: "PATCH", body: { hidden: false } }); await loadNews(); message("Новость возвращена на сайт."); }
      catch (error) { message(error.message, true); restore.disabled = false; }
    });
    actions.append(restore);
  }
  if (!item.hidden || item.source === "manual") {
    const remove = element("button", "Удалить с сайта", "danger"); remove.type = "button";
    remove.addEventListener("click", () => {
      const dialog = $("news-delete-dialog");
      $("news-delete-hint").textContent = item.source === "instagram"
        ? "Публикация исчезнет с сайта и не вернётся при следующем импорте. В самом Instagram она останется. Вернуть её можно из списка скрытых."
        : "Ручная новость будет удалена. Отменить действие нельзя.";
      dialog.returnValue = "cancel"; dialog.showModal();
      dialog.addEventListener("close", async () => {
        if (dialog.returnValue !== "delete") return;
        remove.disabled = true;
        try {
          await api(`/api/admin/news/${encodeURIComponent(item.id)}`, { method: "DELETE", body: {} });
          if (editedNews?.id === item.id) closeNewsEditor();
          await loadNews(); message(item.source === "instagram" ? "Публикация скрыта. Повторный импорт её не вернёт." : "Новость удалена.");
        } catch (error) { message(error.message, true); remove.disabled = false; }
      }, { once: true });
    }); actions.append(remove);
  }
  if (item.link) { const link = element("a", "Оригинал в Instagram ↗"); link.href = item.link; link.target = "_blank"; link.rel = "noopener noreferrer"; actions.append(link); }
  body.append(actions); card.append(body);
  return card;
}
async function loadNews() {
  if (newsLoading || !csrfToken) return;
  newsLoading = true;
  $("refresh-news").disabled = true;
  const requestedPage = newsPage;
  const filter = $("news-filter").value;
  try {
    const data = await api(`/api/admin/news?filter=${encodeURIComponent(filter)}&page=${requestedPage}`);
    if (!csrfToken || filter !== $("news-filter").value || requestedPage !== newsPage) return;
    if (!data.items.length && newsPage > 1) { newsPage--; return; }
    $("news-list").replaceChildren(...data.items.map(newsCard));
    if (!data.items.length) $("news-list").append(element("div", filter === "all" ? "Новостей пока нет. Добавьте первую публикацию или загрузите новости из Instagram." : "В этом списке новостей нет.", "empty"));
    $("news-summary").textContent = `Новостей: ${data.total}`;
    $("news-page-label").textContent = `${data.page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
    $("news-previous").disabled = data.page <= 1;
    $("news-next").disabled = data.page * data.pageSize >= data.total;
    newsConfigured = data.importConfigured;
    newsRunning = data.importing;
    $("import-news").disabled = !newsConfigured || newsImporting || newsRunning;
    const notes = [];
    if (data.importConfigured) {
      notes.push(`${data.account ? `@${data.account}: ` : ""}последние шесть публикаций с #${data.hashtag}.`);
      notes.push(data.autoUpdate ? "Автоматическое обновление — раз в сутки." : "Загрузка по кнопке.");
      notes.push("Удалённые с сайта записи остаются скрытыми.");
      if (data.lastImport) notes.push(`Последняя успешная загрузка: ${date(data.lastImport)} МСК.`);
      if (data.importing) notes.push("Идёт фоновая загрузка. Можно закрыть страницу; новости появятся после завершения.");
      const errors = { instagram_auth: "Instagram отклонил доступ: обновите токен или разрешения.", instagram_account_mismatch: "В загрузчике подключён другой аккаунт.",
        instagram_login_required: "Instagram потребовал вход: обновите сохранённую сессию на загрузчике.", instagram_rate_limited: "Instagram временно ограничил запросы.",
        instagram_private_profile: "Аккаунт Instagram закрыт.", instagram_dependency_missing: "На загрузчике нужно установить Python и Instaloader." };
      if (data.lastError) notes.push(errors[data.lastError] || "Источник недоступен. Сохранённые новости остались на сайте.");
      if (data.autoUpdate && data.nextImport > Date.now()) notes.push(`Следующая проверка: ${date(data.nextImport)} МСК.`);
    } else notes.push(`Для загрузки${data.account ? ` из @${data.account}` : ""} нужно подключить загрузчик Instagram. Ручные новости уже можно добавлять.`);
    $("news-import-hint").textContent = notes.join(" ");
    if (data.importing) newsWatchingImport = true;
    else if (newsWatchingImport) {
      newsWatchingImport = false;
      message(data.lastError ? "Не удалось обновить Instagram. Подробности указаны в разделе новостей; прежние записи сохранены." : importSummary(data.lastResult || {}), !!data.lastError);
    }
  } finally {
    newsLoading = false;
    $("refresh-news").disabled = false;
    if (csrfToken && (filter !== $("news-filter").value || requestedPage !== newsPage)) await loadNews();
  }
}
async function fileData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Не удалось прочитать фотографию."));
    reader.readAsDataURL(file);
  });
}
async function loadAudit() {
  const data = await api("/api/admin/audit");
  if (!csrfToken) return;
  $("audit-list").replaceChildren(...data.items.map(item => {
    const row = element("li"); row.append(element("time", date(item.at)), element("span", events[item.action] || item.action)); return row;
  }));
}
$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.target.querySelector("button"); button.disabled = true;
  try { message(""); await api("/api/admin/login", { method: "POST", body: { password: event.target.elements.password.value }, keepLogin: true }); await enter(); }
  catch (error) { message(error.message, true); }
  finally { button.disabled = false; $("login-password").value = ""; }
});
$("logout").addEventListener("click", async () => {
  try { await api("/api/admin/logout", { method: "POST", body: {} }); signedOut("Вы вышли из кабинета."); }
  catch (error) { message(error.message, true); }
});
$("password-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  if (form.elements.newPassword.value !== form.elements.repeatPassword.value) return message("Новые пароли не совпадают.", true);
  const button = form.querySelector("button"); button.disabled = true;
  try {
    await api("/api/admin/password", { method: "POST", body: { currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value } });
    signedOut("Пароль изменён. Все сеансы завершены. Войдите с новым паролем.");
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; form.reset(); }
});
$("add-news").addEventListener("click", () => openNewsEditor());
$("cancel-news").addEventListener("click", closeNewsEditor);
$("news-image").addEventListener("change", () => {
  const file = $("news-image").files[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 2 * 1024 * 1024) {
    $("news-image").value = ""; message("Выберите JPEG, PNG или WebP размером до 2 МБ.", true); return;
  }
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  $("news-image-preview").src = previewUrl; $("news-image-preview").hidden = false;
  $("news-no-image").checked = false;
});
$("news-no-image").addEventListener("change", () => {
  if ($("news-no-image").checked) { $("news-image").value = ""; $("news-image-preview").hidden = true; }
});
$("news-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.target;
  const button = $("save-news"); button.disabled = true;
  const editing = editedNews;
  try {
    let image = form.elements.noImage.checked ? "" : editing?.image || "";
    const file = form.elements.imageFile.files[0];
    if (file && !form.elements.noImage.checked) image = (await api("/api/admin/news/image", { method: "POST", body: { type: file.type, data: await fileData(file) } })).image;
    await api(editing ? `/api/admin/news/${encodeURIComponent(editing.id)}` : "/api/admin/news", {
      method: editing ? "PATCH" : "POST", body: { title: form.elements.title.value, text: form.elements.text.value, date: form.elements.date.value, image }
    });
    closeNewsEditor(); newsPage = 1; $("news-filter").value = "all";
    await loadNews(); message(editing ? "Изменения новости сохранены." : "Новость опубликована на сайте.");
  } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
});
$("import-news").addEventListener("click", async () => {
  const button = $("import-news");
  newsImporting = true; button.disabled = true; button.textContent = "Загружаем…";
  message("Загружаем публикации и фотографии. Сбор может занять несколько минут.");
  try {
    const data = await api("/api/admin/news/import", { method: "POST", body: {} });
    newsPage = 1; $("news-filter").value = "all";
    newsWatchingImport = data.pending === true;
    await loadNews();
    if (data.pending && newsRunning) message("Загрузка запущена в фоне. Можно закрыть страницу — новости сохранятся после завершения.");
    else if (!data.pending) message(importSummary(data));
  } catch (error) { message(error.message, true); }
  finally { newsImporting = false; button.textContent = "Загрузить из Instagram"; if (csrfToken) button.disabled = !newsConfigured || newsRunning; }
});
function importSummary(data) {
  return `Загрузка завершена. Добавлено: ${data.added || 0}, обновлено: ${data.updated || 0}, оставлено скрытыми: ${data.skipped || 0}.${data.found === 0 ? " Публикаций с нужным хештегом не найдено." : ""}${data.truncated ? ` Проверены последние ${data.scanLimit || 500} публикаций аккаунта; более старые не просматривались.` : ""}${data.videosAdded ? ` Видео загружено: ${data.videosAdded}.` : ""}${data.videosFailed ? ` Видео не загружено: ${data.videosFailed}; для этих новостей сохранена обложка.` : ""}`;
}
setInterval(() => {
  if (csrfToken && currentTab === "news" && newsWatchingImport && !document.hidden) loadNews().catch(error => message(error.message, true));
}, 3000);
$("news-filter").addEventListener("change", () => { newsPage = 1; loadNews().catch(error => message(error.message, true)); });
$("refresh-news").addEventListener("click", () => loadNews().catch(error => message(error.message, true)));
$("news-previous").addEventListener("click", () => { newsPage--; loadNews().catch(error => message(error.message, true)); });
$("news-next").addEventListener("click", () => { newsPage++; loadNews().catch(error => message(error.message, true)); });
document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => selectTab(button.dataset.tab).catch(error => message(error.message, true))));
$("status-filter").addEventListener("change", () => { page = 1; loadLeads().catch(error => message(error.message, true)); });
$("refresh").addEventListener("click", () => loadLeads().catch(error => message(error.message, true)));
$("previous").addEventListener("click", () => { page--; loadLeads().catch(error => message(error.message, true)); });
$("next").addEventListener("click", () => { page++; loadLeads().catch(error => message(error.message, true)); });
setInterval(() => {
  if (csrfToken && currentTab === "leads" && !document.hidden) loadLeads().catch(error => message(error.message, true));
}, 60000);
// Back/forward cache must not restore contacts after a logout in another tab.
window.addEventListener("pageshow", event => { if (event.persisted) { signedOut(); enter().catch(() => signedOut()); } });
enter().catch(error => { if (error.message !== "Сеанс завершён. Войдите заново.") message(error.message, true); });
