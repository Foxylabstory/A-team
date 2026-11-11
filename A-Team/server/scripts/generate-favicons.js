import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const logo = await fs.readFile(path.join(root, 'assets/antipov-team-logo-v2.svg'), 'utf8');
const letter = logo.match(/<g\b[^>]*>[\s\S]*?<\/g>/)?.[0];
if (!letter) throw new Error('The first vector group must contain the original A emblem.');
const executablePath = process.env.BROWSER_EXECUTABLE || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'
].find(existsSync);
if (!executablePath) throw new Error('Set BROWSER_EXECUTABLE to an installed Chromium browser.');
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setContent(`<style>body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" width="1180" height="390" viewBox="0 0 1180 390">${letter}</svg>`);
  const bounds = await page.locator('svg > g').evaluate(el => {
    const box = el.getBoundingClientRect();
    return { x:box.x, y:box.y, width:box.width, height:box.height };
  });
  if (!(bounds.width > 100 && bounds.height > 100)) throw new Error('Invalid emblem bounds.');
  const scale = 52 / Math.max(bounds.width, bounds.height);
  const offsetX = (64 - bounds.width * scale) / 2;
  const offsetY = (64 - bounds.height * scale) / 2;
  const number = value => value.toFixed(6);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><title>ANTIPOV TEAM</title><rect width="64" height="64" rx="12" fill="#0a0a0b"/><defs><mask id="a" x="0" y="0" width="64" height="64" maskUnits="userSpaceOnUse" style="mask-type:luminance"><g transform="translate(${number(offsetX)} ${number(offsetY)}) scale(${number(scale)}) translate(${number(-bounds.x)} ${number(-bounds.y)})">${letter}</g></mask></defs><path fill="#fff" d="M0 0h64v64H0z" mask="url(#a)"/></svg>\n`;
  const raster = async (size, source = svg) => Buffer.from(await page.evaluate(async ({ size, source }) => {
    const image = new Image();
    const url = URL.createObjectURL(new Blob([source], { type:'image/svg+xml' }));
    try {
      image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    } finally { URL.revokeObjectURL(url); }
  }, { size, source }), 'base64');
  const png16 = await raster(16), png32 = await raster(32), png48 = await raster(48);
  const touch = await raster(180, svg.replace('rx="12"', 'rx="0"'));
  // ICO directory entries point to self-contained PNG images at each native size.
  const sizes = [16,32,48], images = [png16,png32,png48];
  const header = Buffer.alloc(6 + 16 * images.length); header.writeUInt16LE(1,2); header.writeUInt16LE(images.length,4);
  let offset = header.length;
  for (let index = 0; index < images.length; index++) {
    const entry = 6 + index * 16;
    header[entry] = header[entry+1] = sizes[index];
    header.writeUInt16LE(1,entry+4); header.writeUInt16LE(32,entry+6);
    header.writeUInt32LE(images[index].length,entry+8); header.writeUInt32LE(offset,entry+12);
    offset += images[index].length;
  }
  const ico = Buffer.concat([header,...images]);
  for (const base of [root,path.join(root,'docs'),path.join(root,'A-Team/server/public')]) {
    await fs.writeFile(path.join(base,'assets/favicon.svg'),svg);
    await fs.writeFile(path.join(base,'assets/favicon-32.png'),png32);
    await fs.writeFile(path.join(base,'assets/apple-touch-icon.png'),touch);
    await fs.writeFile(path.join(base,'favicon.ico'),ico);
  }
  console.log(`Exported original A emblem: SVG, PNG 32, touch 180, ICO 16/32/48 (${svg.length} SVG characters).`);
} finally { await browser.close(); }
