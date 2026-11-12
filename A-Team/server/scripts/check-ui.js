import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { chromium } from "playwright-core";
import express from "express";
import { createApplication } from "../lib/app.js";
import { loadConfig, ROOT } from "../lib/config.js";
import { hashPassword, replacePassword } from "../lib/auth.js";
import { saveLead } from "../lib/database.js";

const executablePath = process.env.BROWSER_EXECUTABLE || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium", "/usr/bin/google-chrome"
].find(existsSync);
if (!executablePath) throw new Error("Укажите путь к установленному Chromium/Chrome/Edge в BROWSER_EXECUTABLE.");
const directory = await mkdtemp(path.join(os.tmpdir(), "antipov-ui-"));
const screenshots = path.join(ROOT, "screenshots");
await mkdir(screenshots, { recursive: true });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lLkAAAAASUVORK5CYII=";
const fullHeadline = "В г. Казани прошли соревнования, на которых участники клуба выступили в нескольких возрастных категориях и завоевали медали в командном зачёте.";
const newsBody = "Подготовка к сезону продолжается.\n\nПоздравляем команду!";
const videoSample = await readFile(path.join(ROOT, "test/fixtures/video-sample.mp4"));
const application = createApplication({ ...loadConfig({}), dataDir: directory, dbPath: path.join(directory, "test.sqlite"), newsFeedUrl: "https://loader.example/news", newsFeedToken: "test-only-source-token", newsAsyncImport: true }, {
  fetchImpl: async url => {
    if (String(url) === "https://loader.example/videos/9001.mp4") {
      assert.ok(videoSample, "the video sample must be generated before import");
      return new Response(videoSample, { headers: { "Content-Type": "video/mp4", "Content-Length": String(videoSample.length) } });
    }
    if (url !== "https://loader.example/news") throw new Error("External services are disabled in browser tests");
    return new Response(JSON.stringify({ schemaVersion: 1, hashtag: "новости", items: [
      { id: "9001", caption: "Тестовый турнир\nПобеда команды. #новости", timestamp: "2026-10-31T12:00:00Z", link: "https://www.instagram.com/p/test9001/", image: { type: "image/png", data: png }, video: { id: "9001", contentType: "video/mp4" } },
      { id: "9002", caption: `${fullHeadline} ${newsBody} #новости`, timestamp: "2026-10-30T12:00:00Z", link: "https://www.instagram.com/p/test9002/", image: { type: "image/png", data: png } }
    ] }), { headers: { "Content-Type": "application/json" } });
  }
});
application.app.use('/A-team', express.static(path.resolve(ROOT, '../../docs')));
const password = "Browser-test-only phrase 2026";
const nextPassword = "Changed-browser-test-only phrase 2026";
replacePassword(application.db, await hashPassword(password));
saveLead(application.db, { name: "Тестовая Анна", phone: "+7 (900) 000-00-01" });
saveLead(application.db, { name: "Тестовый Илья", phone: "+7 (900) 000-00-02" });
const server = application.app.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let page;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    return url.origin === origin || ["blob:", "data:"].includes(url.protocol) ? route.continue() : route.abort();
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#contacts input[name="name"]').waitFor({ state: "visible", timeout: 20000 });
  await page.locator('#reviews .review-card').first().waitFor();
  assert.equal(await page.locator('#reviews .review-card').count(),3);
  await page.getByRole('link',{name:'Рейтинг 2ГИС: 5 из 5, 46 отзывов',exact:true}).waitFor();
  assert.equal(await page.locator('#schedule .schedule-group').count(), 6);
  assert.equal(await page.locator('#schedule .schedule-slots .schedule-row').count(), 14);
  assert.equal(await page.locator('#audience').count(), 0);
  const coachCards = page.locator('#coaches .coach-card');
  await coachCards.first().waitFor();
  assert.equal(await coachCards.count(), 4);
  assert.equal(await coachCards.first().locator('.coach-name').textContent(), 'Сергей Валерьевич Антипов');
  assert.equal(await coachCards.first().locator('.coach-position').textContent(), 'Основатель и директор клуба');
  for (let index = 0; index < 4; index++) {
    const card = coachCards.nth(index);
    const trigger = card.locator('.coach-open');
    await trigger.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => ({ scroll:scrollY, cards:[...document.querySelectorAll('.coach-card')].map(card => { const r=card.getBoundingClientRect();return [r.left,r.top+scrollY,r.width,r.height]; }) }));
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state:'visible' });
    assert.equal(await dialog.locator('h2').textContent(), await card.locator('.coach-name').textContent());
    await page.waitForFunction(index => {
      const image = document.querySelectorAll('#coaches .coach-card img')[index];
      return image?.complete && image.naturalWidth > 0;
    }, index);
    const after = await page.evaluate(() => ({ scroll:scrollY, cards:[...document.querySelectorAll('.coach-card')].map(card => { const r=card.getBoundingClientRect();return [r.left,r.top+scrollY,r.width,r.height]; }) }));
    assert.deepEqual(after, before, 'opening a biography must preserve the entire card grid and page position');
    assert.ok(await dialog.evaluate(el => el.matches(':modal') && el.contains(document.activeElement)));
    await page.keyboard.press('Tab');
    assert.ok(await dialog.evaluate(el => el.contains(document.activeElement)), 'keyboard focus must stay inside the dialog');
    await dialog.getByRole('button', { name:'Закрыть описание тренера', exact:true }).click();
    await dialog.waitFor({ state:'hidden' });
    assert.ok(await trigger.evaluate(el => el === document.activeElement));
    assert.equal(await page.evaluate(() => scrollY), before.scroll);
  }
  await coachCards.first().locator('.coach-open').press('Enter');
  await page.getByRole('dialog').waitFor({ state:'visible' });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state:'hidden' });
  await coachCards.first().locator('.coach-open').click();
  await page.getByRole('dialog').waitFor({ state:'visible' });
  await page.mouse.click(2, 2);
  await page.getByRole('dialog').waitFor({ state:'hidden' });
  await coachCards.first().locator('.coach-open').click();
  await page.getByRole('dialog').locator('.coach-dialog-bio').click();
  await page.getByRole('dialog').waitFor({ state:'hidden' });
  console.log('PASS: all four coach dialogs preserve the grid, trap focus and close with button, backdrop and Escape');
  for (const width of [320, 375, 390, 777, 1440, 1920]) {
    await page.setViewportSize({ width, height:width < 800 ? 884 : 1000 });
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      const selectors = '.site-header,.site-brand,.hero-stats,section,.schedule-group,.schedule-table,.operator-details,.site-footer,.reviews-grid,.review-card,.review-rating,.coaches-grid,.coach-card';
      const overflow = [...document.querySelectorAll(selectors)].filter(el => {
        const box = el.getBoundingClientRect();
        return box.left < -1 || box.right > innerWidth + 1;
      }).map(el => el.id || el.className);
      const clippedCells = [...document.querySelectorAll('.schedule-table [role="columnheader"],.schedule-table [role="cell"]')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent);
      const logo = document.querySelector('[data-antipov-logo="header"]').getBoundingClientRect();
      const emblem = document.querySelector('[data-antipov-logo="hero"]').getBoundingClientRect();
      const stats = document.querySelector('.hero-stats').getBoundingClientRect();
      const ids = [...document.querySelectorAll('section[id]')].map(el => el.id);
      const caption = document.querySelector('.brand-caption');
      const captionLine = parseFloat(getComputedStyle(caption).lineHeight);
      const captionSingleLine = caption.getBoundingClientRect().height <= captionLine + 1;
      const captionPartsUnbroken = [...caption.children].every(el => el.getBoundingClientRect().height <= captionLine + 1);
      const coachHeights = [...document.querySelectorAll('.coach-card')].map(el => el.getBoundingClientRect().height);
      return { overflow, clippedCells, logoCenter:(logo.left + logo.right) / 2, statsBelowLogo:stats.top >= emblem.bottom,
        captionSingleLine, captionPartsUnbroken, equalCoaches:Math.max(...coachHeights)-Math.min(...coachHeights)<1.5,
        newsAboveDirections:ids.indexOf('news') < ids.indexOf('directions'), coachesAboveGallery:ids.indexOf('coaches') < ids.indexOf('gallery') };
    });
    assert.deepEqual(layout.overflow, [], `page content must fit ${width}px`);
    assert.ok(layout.equalCoaches, `all closed coach cards must have the same height at ${width}px`);
    assert.deepEqual(layout.clippedCells, [], `all schedule columns must fit ${width}px`);
    if (width <= 900) assert.ok(Math.abs(layout.logoCenter - width / 2) < 1.5, `header logo must be centered at ${width}px`);
    assert.ok(layout.captionPartsUnbroken, `club title and city must each stay on one line at ${width}px`);
    if (width >= 777) assert.ok(layout.captionSingleLine, `caption must use one line when space permits at ${width}px`);
    assert.ok(layout.statsBelowLogo && layout.newsAboveDirections && layout.coachesAboveGallery);
    await coachCards.first().locator('.coach-open').click();
    await page.getByRole('dialog').waitFor({ state:'visible' });
    const dialogLayout = await page.getByRole('dialog').evaluate(el => {
      const box=el.getBoundingClientRect();
      return { fits:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,
        background:getComputedStyle(el).backgroundColor, textFits:el.querySelector('.coach-dialog-description').scrollWidth<=el.querySelector('.coach-dialog-description').clientWidth+1 };
    });
    assert.ok(dialogLayout.fits && dialogLayout.textFits, `coach dialog must fit ${width}px`);
    assert.equal(dialogLayout.background, 'rgb(16, 17, 21)', 'dialog styles must apply outside the rendered card grid');
    if (width === 320) {
      await page.screenshot({ path:path.join(screenshots, 'coach-dialog-mobile-320.png') });
      await page.locator('.coach-dialog-content').hover();
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('.coach-dialog-content').scrollTop>100);
      await page.screenshot({ path:path.join(screenshots, 'coach-dialog-mobile-text-320.png') });
    }
    if (width === 1440) await page.screenshot({ path:path.join(screenshots, 'coach-dialog-desktop.png') });
    await page.getByRole('dialog').getByRole('button', { name:'Закрыть описание тренера', exact:true }).click();
    await page.getByRole('dialog').waitFor({ state:'hidden' });
    if (width === 320) {
      await page.screenshot({ path:path.join(screenshots, 'landing-mobile-320.png') });
      await page.locator('#schedule').screenshot({ path:path.join(screenshots, 'schedule-mobile-320.png') });
      await page.locator('#reviews').screenshot({ path:path.join(screenshots, 'reviews-mobile-320.png') });
    }
  }
  const cards = page.locator('#directions .direction-card');
  assert.equal(await cards.count(), 7);
  for (let index = 0; index < 7; index++) {
    const card = cards.nth(index);
    const target = await card.getAttribute('href');
    assert.equal(await card.evaluate(el => getComputedStyle(el).cursor), 'pointer');
    await card.click();
    await page.waitForURL(`${origin}/${target}`);
  }
  await cards.first().press('Enter');
  await page.waitForURL(`${origin}/#schedule-wrestling`);
  console.log('PASS: all seven direction cards link to their schedule; keyboard navigation and responsive header caption work');
  const slider = page.locator('.discipline-window');
  const beforeRight = await slider.evaluate(el => el.scrollLeft);
  await page.getByRole('button', { name:'Следующие направления', exact:true }).click();
  await page.waitForFunction(initial => document.querySelector('.discipline-window').scrollLeft > initial + 180, beforeRight);
  const afterRight = await slider.evaluate(el => el.scrollLeft);
  await page.getByRole('button', { name:'Предыдущие направления', exact:true }).click();
  await page.waitForFunction(right => document.querySelector('.discipline-window').scrollLeft < right - 100, afterRight);
  await slider.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.discipline-window').scrollLeft > 0);
  await page.goto(origin);
  await page.locator('#contacts input[name="name"]').waitFor({ state: "visible" });
  await page.screenshot({ path:path.join(screenshots, 'landing-desktop.png') });
  await page.locator('#reviews').screenshot({ path:path.join(screenshots, 'reviews-section-desktop.png') });
  await page.locator('#coaches').screenshot({ path:path.join(screenshots, 'coaches-desktop.png') });
  console.log('PASS: landing content and schedule fit 320/375/390/777/1440px; section order and bidirectional slider work');
  const developer = page.getByRole('button', { name:/Хочу такой же крутой сайт/ });
  await developer.click();
  const email = page.getByRole('link', { name:'rushan.shakirzianov@gmail.com', exact:true });
  await email.waitFor();
  assert.equal(await developer.count(), 0);
  assert.match(await email.getAttribute('href'), /^mailto:rushan\.shakirzianov@gmail\.com\?subject=/);
  await page.waitForFunction(() => document.activeElement.matches('.developer-email'));
  await page.locator('.developer-credit').screenshot({ path:path.join(screenshots, 'developer-contact.png') });
  console.log('PASS: developer prompt becomes a focused mail link');
  const staticPage = await context.newPage();
  const staticRequests = [];
  staticPage.on('request', request => staticRequests.push(request.url()));
  await staticPage.goto(`${origin}/A-team/`);
  await staticPage.getByRole('link', { name:'Записаться: +7 960 080 25 52', exact:true }).waitFor();
  await staticPage.locator('#reviews .review-card').first().waitFor();
  assert.equal(await staticPage.locator('#reviews .review-card').count(),3);
  assert.equal(await staticPage.locator('#contacts form').count(), 0);
  assert.equal(await staticPage.getByRole('link', { name:'Кабинет администратора', exact:true }).count(), 0);
  assert.ok(await staticPage.locator('[data-antipov-logo="header"]').evaluate(el => el.complete && el.naturalWidth > 0));
  await staticPage.locator('.coach-open').first().click();
  await staticPage.getByRole('dialog', { name:'Сергей Валерьевич Антипов', exact:true }).waitFor();
  assert.ok(await staticPage.locator('.coach-dialog-photo').evaluate(el=>new URL(el.src).pathname.startsWith('/A-team/assets/coaches/')));
  await staticPage.keyboard.press('Escape');
  assert.ok(!staticRequests.some(url => new URL(url).pathname.startsWith('/api/')), 'static Pages must not call the server API');
  await staticPage.setViewportSize({ width:375, height:884 });
  await staticPage.screenshot({ path:path.join(screenshots, 'pages-mobile.png') });
  const initialPosition = await staticPage.locator('.discipline-window').evaluate(el => el.scrollLeft);
  await staticPage.getByRole('button', { name:'Предыдущие направления', exact:true }).click();
  await staticPage.waitForFunction(initial => document.querySelector('.discipline-window').scrollLeft < initial - 200, initialPosition);
  await staticPage.waitForFunction(initial => document.querySelector('.discipline-window').scrollLeft > initial - 210, initialPosition, { timeout:3000 });
  const scheduleLink = staticPage.locator('.discipline-set:not([aria-hidden]) a[href="#schedule-mma"]');
  await scheduleLink.click();
  await staticPage.waitForURL('**/#schedule-mma');
  console.log('PASS: carousel resumes after manual scroll; discipline links open the right schedule');
  await staticPage.close();
  console.log('PASS: standalone Pages under /A-team/ loads logo and static news without API; signup uses the real phone');
  await page.locator('#contacts input[name="name"]').fill("Тестовая заявка с сайта");
  await page.locator('#contacts input[name="phone"]').fill("+7 (900) 000-00-03");
  await page.locator('#contacts input[type="checkbox"]').check();
  await page.locator('#contacts button[type="submit"]').click();
  await page.getByText("Заявка принята — перезвоним в течение рабочего дня.", { exact: true }).waitFor();
  assert.equal(application.db.prepare("SELECT count(*) AS n FROM leads").get().n, 3);
  console.log("PASS: real landing form saves a lead before confirming success");

  await page.goto(`${origin}/admin/`);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.locator(".lead").first().waitFor();
  assert.equal(await page.locator(".lead").count(), 3);
  await page.screenshot({ path: path.join(screenshots, "admin-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile view must not overflow horizontally");
  await page.screenshot({ path: path.join(screenshots, "admin-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(".lead select").first().selectOption("booked");
  await page.getByText("Статус сохранён.", { exact: true }).waitFor();
  await page.getByLabel("Статус заявки").selectOption("booked");
  await page.waitForFunction(() => document.querySelectorAll(".lead").length === 1);
  assert.equal(await page.locator(".lead-name").textContent(), "Тестовая заявка с сайта");
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить", exact: true }).click();
  await page.getByText("Заявка удалена.", { exact: true }).waitFor();
  assert.equal(application.db.prepare("SELECT count(*) AS n FROM leads").get().n, 2);
  console.log("PASS: admin login, mobile layout, filter, status change and deletion");

  await page.getByRole("button", { name: "Новости", exact: true }).click();
  await page.getByText(/Автоматическое обновление — раз в сутки\./).waitFor();
  await page.getByRole("button", { name: "Добавить новость", exact: true }).click();
  await page.getByLabel("Заголовок новости", { exact: true }).fill("Тестовая новость клуба");
  await page.getByLabel("Текст новости", { exact: true }).fill("Ручная публикация с фотографией на сервере клуба.");
  await page.getByLabel("Дата публикации", { exact: true }).fill("2026-11-02");
  await page.getByLabel("Фото с компьютера", { exact: true }).setInputFiles({ name: "test.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.getByRole("button", { name: "Опубликовать новость", exact: true }).click();
  await page.getByText("Новость опубликована на сайте.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  await page.getByLabel("Текст новости", { exact: true }).fill("Отредактированная ручная публикация с локальной фотографией.");
  await page.getByRole("button", { name: "Сохранить изменения", exact: true }).click();
  await page.getByText("Изменения новости сохранены.", { exact: true }).waitFor();
  const importResponse = page.waitForResponse(response => response.url().endsWith('/api/admin/news/import') && response.request().method() === 'POST');
  await page.getByRole("button", { name: "Загрузить из Instagram", exact: true }).click();
  assert.equal((await importResponse).status(), 202);
  await page.waitForFunction(() => document.getElementById("message").textContent.startsWith("Загрузка завершена."));
  assert.equal(await page.locator(".news-card").count(), 3);
  const storedVideo = application.db.prepare("SELECT video,has_video,video_error FROM news_items WHERE source_id='9001'").get();
  assert.equal(storedVideo.video_error, "", `The MP4 import failed; header=${videoSample.subarray(0,16).toString('hex')}`);
  assert.ok(storedVideo.video);
  await page.screenshot({ path: path.join(screenshots, "news-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "news mobile layout must not overflow");
  await page.screenshot({ path: path.join(screenshots, "news-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const publicPage = await context.newPage();
  await publicPage.goto(origin + "/#news");
  await publicPage.getByRole("heading", { name: "Тестовая новость клуба", exact: true }).waitFor();
  await publicPage.getByRole("heading", { name: "Тестовый турнир", exact: true }).waitFor();
  const photoCard = publicPage.locator("#news .news-card").filter({ has: publicPage.getByRole("heading", { name: fullHeadline, exact: true }) });
  await photoCard.locator(".news-headline[data-preview]").waitFor();
  const cover = photoCard.locator("img");
  await cover.scrollIntoViewIfNeeded();
  const box = await cover.boundingBox();
  await publicPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const newsDialog = publicPage.getByRole("dialog", { name: fullHeadline, exact: true });
  await newsDialog.waitFor();
  assert.equal(await newsDialog.locator(".coach-dialog-bio").textContent(), newsBody);
  await publicPage.keyboard.press("Escape");
  await photoCard.locator(".news-open").press("Enter");
  await newsDialog.waitFor();
  await publicPage.keyboard.press("Escape");
  console.log('PASS: news cover and keyboard open the full sentence and remaining caption');
  const newsVideo = publicPage.locator('#news video');
  await newsVideo.waitFor({ state: 'visible' });
  assert.equal(await newsVideo.count(), 1);
  assert.equal(await newsVideo.getAttribute('preload'), 'none');
  assert.equal(await newsVideo.getAttribute('autoplay'), null);
  await newsVideo.evaluate(async video => { video.muted = true; await video.play(); });
  await publicPage.waitForFunction(() => { const video = document.querySelector('#news video'); return video && video.currentTime > 0 && video.videoWidth > 0; });
  assert.ok(await newsVideo.evaluate(video => video.videoWidth > 0));
  await newsVideo.evaluate(video => video.pause());
  console.log('PASS: news video has native controls, loads on demand and plays an actual MP4 in the browser');
  const instagramCard = page.locator(".news-card").filter({ has: page.getByRole("heading", { name: "Тестовый турнир", exact: true }) });
  await page.bringToFront();
  await instagramCard.getByRole("button", { name: "Удалить с сайта", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить новость", exact: true }).click();
  await page.getByText("Публикация скрыта. Повторный импорт её не вернёт.", { exact: true }).waitFor();
  application.db.exec("DELETE FROM rate_limits");
  await page.getByRole("button", { name: "Загрузить из Instagram", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("message").textContent.startsWith("Загрузка завершена."));
  assert.equal(await page.locator(".news-card").count(), 2);
  await publicPage.reload({ waitUntil:'domcontentloaded' });
  await publicPage.getByRole("heading", { name: "Тестовая новость клуба", exact: true }).waitFor();
  assert.equal(await publicPage.getByRole("heading", { name: "Тестовый турнир", exact: true }).count(), 0);
  await page.getByLabel("Показать новости", { exact: true }).selectOption("hidden");
  await page.getByRole("button", { name: "Вернуть на сайт", exact: true }).click();
  await page.getByText("Новость возвращена на сайт.", { exact: true }).waitFor();
  await page.getByLabel("Показать новости", { exact: true }).selectOption("manual");
  await page.locator(".news-card").first().waitFor();
  await page.getByRole("button", { name: "Удалить с сайта", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить новость", exact: true }).click();
  await page.getByText("Новость удалена.", { exact: true }).waitFor();
  assert.equal(application.db.prepare("SELECT count(*) AS n FROM news_items WHERE source='manual'").get().n, 0);
  await publicPage.close();
  console.log("PASS: manual news with local photo, edit, Instagram import, persistent hiding, restore and delete");

  const other = await context.newPage();
  await other.goto(`${origin}/admin/`);
  await other.locator(".lead").first().waitFor();
  await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
  const changePasswordForm = page.locator('#password-form');
  await changePasswordForm.getByLabel('Текущий пароль', { exact: true }).fill(password);
  await changePasswordForm.getByLabel('Новый пароль', { exact: true }).fill(nextPassword);
  await changePasswordForm.getByLabel('Повторите новый пароль', { exact: true }).fill(nextPassword);
  await page.getByRole("button", { name: "Сменить пароль и завершить все сеансы" }).click();
  await page.getByText("Пароль изменён. Все сеансы завершены. Войдите с новым паролем.", { exact: true }).waitFor();
  await other.getByRole("button", { name: "Обновить", exact: true }).click();
  await other.getByRole("button", { name: "Войти", exact: true }).waitFor();
  assert.equal(await other.locator(".lead").count(), 0);
  await page.getByLabel("Пароль", { exact: true }).fill(nextPassword);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await page.locator(".lead").first().waitFor();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByText("Вы вышли из кабинета.", { exact: true }).waitFor();
  console.log('PASS: password change clears contacts in another tab, new login and logout');

  await page.getByLabel('Пароль', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
  await page.getByLabel('Пароль для создания кода').fill(nextPassword);
  await page.getByRole('button', { name: 'Создать код', exact: true }).click();
  const issuedCode = page.getByLabel('Сохраните одноразовый код');
  await issuedCode.waitFor();
  const code = await issuedCode.inputValue();
  assert.match(code, /^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await page.getByRole('button', { name: 'Забыли пароль?' }).click();
  const recoveryForm = page.locator('#recovery-form');
  const recoveredPassword = 'Recovery test password phrase';
  await recoveryForm.getByLabel('Код восстановления').fill(code);
  await recoveryForm.getByLabel('Новый пароль', { exact: true }).fill(recoveredPassword);
  await recoveryForm.getByLabel('Повторите новый пароль').fill(recoveredPassword);
  await recoveryForm.getByRole('button', { name: 'Задать новый пароль' }).click();
  await page.getByText('Пароль восстановлен. Войдите с новым паролем и создайте новый код.').waitFor();
  await page.getByLabel('Пароль', { exact: true }).fill(recoveredPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.locator('.lead').first().waitFor();
  await page.getByRole('button', { name: 'Сменить пароль', exact: true }).click();
  await page.getByRole('button', { name: 'Создать код', exact: true }).waitFor();
  assert.equal(await issuedCode.inputValue(), '');
  console.log('PASS: recovery code is issued once, resets access and is cleared from the browser');
  assert.deepEqual(errors, [], "no JavaScript errors in landing or dashboard");
  console.log("Screenshots:", screenshots);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(screenshots, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await application.close();
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith("antipov-ui-"));
  await rm(directory, { recursive: true, force: true });
}
