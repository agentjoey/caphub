#!/usr/bin/env node
// Full-page screenshots via Playwright (@playwright/test's chromium), for M2 visual
// verification. Two shots per path: a desktop viewport and a scaled mobile viewport.
// Also checks, per shot, for horizontal overflow and any internal id text
// (cap_/cab_/run_...) leaking outside a <details> element.
//
// usage: node scripts/shot.mjs [--cookie name=value]... <baseUrl> <outDir> <path...>
//   --cookie sets a cookie on baseUrl before each shot (e.g. --cookie lang=en for the EN UI).
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const cookies = [];
while (args[0] === "--cookie") {
  const [name, ...rest] = (args[1] ?? "").split("=");
  if (!name || rest.length === 0) {
    console.error("--cookie expects name=value");
    process.exit(1);
  }
  cookies.push({ name, value: rest.join("=") });
  args.splice(0, 2);
}
const [baseUrl, outDir, ...paths] = args;
if (!baseUrl || !outDir || paths.length === 0) {
  console.error("usage: node scripts/shot.mjs [--cookie name=value]... <baseUrl> <outDir> <path...>");
  process.exit(1);
}

const VIEWPORTS = [
  { label: 1440, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { label: 390, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
];

/** An internal id (cap_/cab_/run_...) is only allowed inside a collapsed <details> block. */
const INTERNAL_ID_PATTERN = /\b(cap|cab|run)_[0-9a-f]{8,}/;

function slugify(path) {
  if (path === "/") return "home";
  return path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

async function checkPage(page) {
  return page.evaluate((pattern) => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const clone = document.body.cloneNode(true);
    // textContent includes text nodes that are never rendered to the user — <script> (Next
    // embeds its RSC payload there), <style>, <noscript>, and <template> — plus collapsed
    // <details>. Strip all of those before checking so the id check reflects visible text only.
    clone.querySelectorAll("script, style, noscript, template, details").forEach((el) => el.remove());
    const text = clone.textContent || "";
    const internalIdVisible = new RegExp(pattern).test(text);
    return { overflow, internalIdVisible };
  }, INTERNAL_ID_PATTERN.source);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  let failed = false;

  try {
    for (const path of paths) {
      const slug = slugify(path);
      const url = new URL(path, baseUrl).toString();
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: vp.viewport,
          deviceScaleFactor: vp.deviceScaleFactor,
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch
        });
        if (cookies.length > 0) {
          await context.addCookies(cookies.map((c) => ({ ...c, url: baseUrl })));
        }
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "networkidle" });
          const { overflow, internalIdVisible } = await checkPage(page);
          const outPath = `${outDir}/${slug}-${vp.label}.png`;
          await page.screenshot({ path: outPath, fullPage: true });
          const summary = { path, width: vp.label, horizontalOverflow: overflow, internalIdVisible };
          console.log(JSON.stringify(summary));
          results.push(summary);
          if (overflow || internalIdVisible) failed = true;
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (failed) {
    console.error("FAIL: horizontal overflow or a visible internal id was found (see summaries above)");
    process.exitCode = 1;
  }
  return results;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
