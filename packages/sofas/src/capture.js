"use strict";

const { chromium } = require("playwright");
const { modelKey } = require("@ikea-planner-assets/storage-one");
const { extractSofaCatalog } = require("./catalog");
const { parseSofaReference } = require("./reference");

async function captureSofaPlan(input, options = {}, range = null) {
  const reference = input && typeof input === "object" && input.plannerUrl && input.code && input.range
    ? input
    : parseSofaReference(input, options, range);
  if (reference.kind === "spr") {
    throw new Error("A standalone SPR product link is not a saved sofa design. Open it in the planner and share the resulting design code first.");
  }

  const timeoutMs = positiveNumber(options.timeoutMs, 90000);
  const settleMs = nonNegativeNumber(options.settleMs, 1500);
  const browser = await chromium.launch({
    headless: options.headed !== true,
    executablePath: options.executablePath,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: options.viewport || { width: 1440, height: 1000 },
    userAgent: options.userAgent,
  });
  const page = await context.newPage();
  const capturedUrls = new Set();
  const modelAssets = new Map();
  const responseErrors = [];
  const pending = new Set();
  let plan = null;
  let settings = null;
  let core = null;
  let catalog = null;
  let catalogSource = null;
  let catalogUrl = null;
  let planUrl = null;
  let resolvePlan;
  let resolveCatalog;
  const planReady = new Promise((resolve) => { resolvePlan = resolve; });
  const catalogReady = new Promise((resolve) => { resolveCatalog = resolve; });

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  page.on("response", (response) => {
    const url = response.url();
    if (response.status() < 200 || response.status() >= 300) return;
    if (isPlanUrl(url, reference.code)) {
      track(captureJson(response, (payload) => {
        if (payload?.configuration?.content?.entities) {
          plan = payload;
          planUrl = url;
          capturedUrls.add(url);
          resolvePlan(payload);
        }
      }, responseErrors));
    } else if (isCatalogUrl(url)) {
      track(captureText(response, (source) => {
        catalogSource = source;
        catalogUrl = url;
        catalog = extractSofaCatalog(source, url);
        capturedUrls.add(url);
        resolveCatalog(catalog);
      }, responseErrors));
    } else if (/\/addon-app\/sofas\/content\/[^/]+\/[^/]+-core\.json(?:[?#]|$)/i.test(url)) {
      track(captureJson(response, (payload) => {
        core = payload;
        capturedUrls.add(url);
      }, responseErrors));
    } else if (/\/setting\/v1\/data\/apps\//i.test(url)) {
      track(captureJson(response, (payload) => {
        settings = payload;
        capturedUrls.add(url);
      }, responseErrors));
    } else if (/\.glb(?:[?#]|$)/i.test(url) && /content\.dexf\.ikea\.com/i.test(url)) {
      track(captureBuffer(response, (buffer) => {
        const key = modelKey(url);
        modelAssets.set(url, {
          key,
          url,
          contentType: response.headers()["content-type"] || "model/gltf-binary",
          buffer,
        });
        capturedUrls.add(url);
      }, responseErrors));
    }
  });

  try {
    await page.goto(reference.plannerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await withTimeout(Promise.all([planReady, catalogReady]), timeoutMs, `Timed out waiting for sofa design ${reference.code}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) }).catch(() => {});
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await waitForPending(pending);
  } finally {
    await browser.close();
  }

  if (!plan) throw new Error(`The planner did not return public configuration ${reference.code}`);
  if (!catalog) throw new Error(`The planner did not return the ${reference.range} model catalog`);
  return {
    reference,
    plan,
    planUrl,
    settings,
    core,
    catalog,
    catalogSource,
    catalogUrl,
    appVersion: versionFromCatalogUrl(catalogUrl),
    contentVersion: core?.version || versionFromCoreUrl(Array.from(capturedUrls).find((url) => /-core\.json/i.test(url))),
    modelAssets,
    capturedUrls: Array.from(capturedUrls).sort(),
    responseErrors,
  };
}

function isPlanUrl(url, code) {
  try {
    const parsed = new URL(url);
    return /\/vpc\/v1\/configurations\/retailunit\//i.test(parsed.pathname)
      && parsed.pathname.toUpperCase().endsWith(`/${String(code).replace(/^SPR-/i, "").toUpperCase()}`);
  } catch {
    return false;
  }
}

function isCatalogUrl(url) {
  try {
    const parsed = new URL(url);
    return /\/addon-app\/sofas\/version\/[^/]+\/assets\/catalog-[^/]+\.js$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function versionFromCatalogUrl(url) {
  return String(url || "").match(/\/version\/([^/]+)\/assets\//i)?.[1] || null;
}

function versionFromCoreUrl(url) {
  return String(url || "").match(/\/content\/([^/]+)\//i)?.[1] || null;
}

async function captureJson(response, accept, errors) {
  try {
    accept(await response.json());
  } catch (error) {
    errors.push({ url: response.url(), kind: "json", error: error.message });
  }
}

async function captureText(response, accept, errors) {
  try {
    accept(await response.text());
  } catch (error) {
    errors.push({ url: response.url(), kind: "text", error: error.message });
  }
}

async function captureBuffer(response, accept, errors) {
  try {
    accept(await response.body());
  } catch (error) {
    errors.push({ url: response.url(), kind: "buffer", error: error.message });
  }
}

async function waitForPending(pending) {
  while (pending.size) await Promise.allSettled(Array.from(pending));
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

module.exports = {
  captureSofaPlan,
  isCatalogUrl,
  isPlanUrl,
  versionFromCatalogUrl,
};
