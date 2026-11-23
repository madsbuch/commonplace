// The Commonplace mark (APP-3), every form of it from one geometry: a C of
// page edges, seen from the end of a book, and its ribbon, tucked between the
// pages and hanging out below, as a bookmark does.
//
//   node scripts/logo.mjs
//
// writes the SVGs (src/assets/logo.svg, logo-round.svg,
// logo-android-foreground.svg, public/favicon.svg) and renders the PNGs with
// Playwright's Chromium: app-icon.png, .spec/assets/logo.png and Android's
// icons (src-tauri/icons/android). For the desktop icons, run
// `bun run tauri icon app-icon.png` after it, then this again: `tauri icon`
// overwrites Android's with its own.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const INK = ["#2c3a57", "#18202f"];
/** The ink blue Android shows behind the mark (ic_launcher_background). */
const INK_MIDDLE = "#222c42";
const RIBBON = "#e0895f";
/** Degrees either side of the C's opening. */
const OPEN = 40;
/** The pages, inside out. Solid tints of the paper colour over the ink, so the ribbon behind them doesn't show through. */
const PAGES = [
  { r: 140, w: 32, color: "#8b8c8e" },
  { r: 214, w: 40, color: "#bdbab4" },
  { r: 290, w: 50, color: "#f4ecdc" },
];
const RIBBON_WIDTH = 64;
/** How far the ribbon hangs below the outer page, and the depth of the notch in its end. */
const HANG = 150;
const NOTCH = 34;
/** Where the ribbon hangs, left of the C's lowest point, as a ribbon leaves a book's foot. */
const RIBBON_OFFSET = -52;

const outer = PAGES[2];
// The C's centre, placed so the whole mark (C and ribbon) is centred in 1024 × 1024.
const half = outer.r + outer.w / 2;
const right = outer.r * Math.cos((OPEN * Math.PI) / 180) + outer.w / 2;
const CX = 512 - (right - half) / 2;
const CY = 512 - (outer.r + HANG - half) / 2;

const f = (n) => n.toFixed(1);

function arc(r) {
  const a = (OPEN * Math.PI) / 180;
  const x = CX + r * Math.cos(a);
  return `M${f(x)} ${f(CY - r * Math.sin(a))} A${r} ${r} 0 1 0 ${f(x)} ${f(CY + r * Math.sin(a))}`;
}

function stroke(page, extra = "") {
  return `<path d="${arc(page.r)}" fill="none" stroke="${page.color}" stroke-width="${page.w}" stroke-linecap="round"${extra}/>`;
}

/** The mark, at `scale` about the middle; `id` keeps its clip path apart from another's. */
function mark(scale, id) {
  const middle = PAGES[1];
  const rx = CX + RIBBON_OFFSET;
  // From under the middle page, down past the outer one.
  const top = CY + Math.sqrt(middle.r ** 2 - RIBBON_OFFSET ** 2) - 6;
  const bottom = CY + outer.r + HANG;
  const w = RIBBON_WIDTH / 2;
  const ribbon = `M${f(rx - w)} ${f(top)} H${f(rx + w)} V${f(bottom)} L${f(rx)} ${f(bottom - NOTCH)} L${f(rx - w)} ${f(bottom)} Z`;
  // The pages over it cast a little shadow on it, so it reads as tucked in.
  const shade = (page) =>
    `<path d="${arc(page.r)}" fill="none" stroke="#000" stroke-opacity="0.32" stroke-width="${page.w + 16}" stroke-linecap="round" clip-path="url(#${id})"/>`;
  return `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">
<clipPath id="${id}"><path d="${ribbon}"/></clipPath>
${stroke(PAGES[0])}
<path d="${ribbon}" fill="${RIBBON}"/>
${shade(middle)}
${stroke(middle)}
${shade(outer)}
${stroke(outer)}
</g>`;
}

const gradient = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${INK[0]}"/><stop offset="1" stop-color="${INK[1]}"/></linearGradient>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">\n${body}\n</svg>\n`;

/** The app's icon: a rounded tile. */
const tile = svg(`<defs>${gradient}</defs>
<rect x="32" y="32" width="960" height="960" rx="216" fill="url(#bg)"/>
${mark(0.94, "ribbon")}`);

/** For launchers that want a round icon. */
const round = svg(`<defs>${gradient}<clipPath id="c"><circle cx="512" cy="512" r="496"/></clipPath></defs>
<g clip-path="url(#c)"><rect width="1024" height="1024" fill="url(#bg)"/>${mark(0.86, "ribbon")}</g>`);

/** Android's adaptive icon's foreground: the mark alone, inside the 66 dp of 108 every launcher's mask keeps. */
const foreground = svg(mark(0.78, "ribbon"));

const out = (path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
out("src/assets/logo.svg", tile);
out("src/assets/logo-round.svg", round);
out("src/assets/logo-android-foreground.svg", foreground);
out("public/favicon.svg", tile);
out(
  "src-tauri/icons/android/values/ic_launcher_background.xml",
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <!-- The Commonplace logo's ink blue (src/assets/logo.svg). -->
  <color name="ic_launcher_background">${INK_MIDDLE.toUpperCase()}</color>
</resources>
`,
);

// The PNGs, drawn by Chromium at each size.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(source, size, path) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${source.replace("<svg ", `<svg style="display:block;width:${size}px;height:${size}px" `)}</body>`);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  await page.screenshot({ path: join(root, path), omitBackground: true });
}
await png(tile, 1024, "app-icon.png");
await png(tile, 1024, ".spec/assets/logo.png");
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENSITIES)) {
  await png(tile, 48 * k, `src-tauri/icons/android/mipmap-${d}/ic_launcher.png`);
  await png(round, 48 * k, `src-tauri/icons/android/mipmap-${d}/ic_launcher_round.png`);
  await png(foreground, 108 * k, `src-tauri/icons/android/mipmap-${d}/ic_launcher_foreground.png`);
}
await browser.close();
console.error("The logo's SVGs and PNGs are written.");
