"use strict";

const { chromium } = require("playwright");
const { extractCatalogProducts, modelKey } = require("./catalog");
const { storageOneProfile } = require("./profile");
const { parseStorageOneReference } = require("./reference");

async function capturePlatsa(input, options = {}) {
  return captureStorageOne(input, options, "platsa");
}

async function capturePax(input, options = {}) {
  return captureStorageOne(input, options, "pax");
}

async function captureStorageOne(input, options = {}, planner = "platsa") {
  const profile = storageOneProfile(planner);
  const reference = typeof input === "object" && input.planId
    ? input
    : parseStorageOneReference(input, options, profile);
  const timeoutMs = positiveNumber(options.timeoutMs, 90000);
  const settleMs = nonNegativeNumber(options.settleMs, 1200);
  const browser = await chromium.launch({ headless: options.headed !== true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    userAgent: options.userAgent,
  });
  const page = await context.newPage();
  const catalogProducts = new Map();
  const modelAssets = new Map();
  const productLabels = new Map();
  const responseErrors = [];
  const capturedUrls = new Set();
  const pending = new Set();
  let plan = null;
  let resolvePlan;
  const planReady = new Promise((resolve) => { resolvePlan = resolve; });

  const track = (promise) => {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  };

  page.on("response", (response) => {
    const url = response.url();
    if (response.status() < 200 || response.status() >= 300) return;
    if (isPlanUrl(url, reference.planId)) {
      track(captureJson(response, (payload) => {
        if (payload?.configuration?.content?.entities) {
          plan = payload;
          capturedUrls.add(url);
          resolvePlan(payload);
        }
      }, responseErrors));
    } else if (/\/static\/js\/[^/?]*catalog-[^/?]+\.js(?:[?#]|$)/i.test(url)) {
      track(captureText(response, (source) => {
        for (const product of extractCatalogProducts(source, url)) {
          if (!catalogProducts.has(product.id)) catalogProducts.set(product.id, product);
        }
        capturedUrls.add(url);
      }, responseErrors));
    } else if (/\/webplanner\/v1\/query\/items\//i.test(url)) {
      track(captureJson(response, (payload) => {
        for (const item of payload?.data || []) {
          const content = item?.content || {};
          const id = String(content.ruItemNo || content.itemNoGlobal || "");
          if (!id) continue;
          productLabels.set(id, {
            name: content.name || null,
            typeName: content.typeName || content.mainTypeName || null,
            itemId: item.itemId || null,
          });
        }
        capturedUrls.add(url);
      }, responseErrors));
    } else if (/\.glb(?:[?#]|$)/i.test(url) && /content\.dexf\.ikea\.com/i.test(url)) {
      track(captureBuffer(response, (buffer) => {
        const key = modelKey(url);
        if (key && !modelAssets.has(key)) {
          modelAssets.set(key, {
            key,
            url,
            contentType: response.headers()["content-type"] || "model/gltf-binary",
            buffer,
          });
        }
        capturedUrls.add(url);
      }, responseErrors));
    }
  });

  try {
    await page.goto(reference.plannerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await withTimeout(planReady, timeoutMs, `Timed out waiting for ${profile.label} plan ${reference.planId}`);
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, 30000) }).catch(() => {});
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    await waitForPending(pending);
  } finally {
    await browser.close();
  }

  if (!plan) throw new Error(`The planner did not return configuration ${reference.planId}`);
  return {
    reference,
    plan,
    catalogProducts,
    modelAssets,
    productLabels,
    capturedUrls: Array.from(capturedUrls).sort(),
    responseErrors,
  };
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

function isPlanUrl(url, planId) {
  try {
    const parsed = new URL(url);
    return /\/vpc\/v1\/configurations\/retailunit\//i.test(parsed.pathname)
      && parsed.pathname.toUpperCase().endsWith(`/${String(planId).toUpperCase()}`);
  } catch {
    return false;
  }
}

async function waitForPending(pending) {
  while (pending.size) {
    await Promise.allSettled(Array.from(pending));
  }
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

module.exports = { capturePax, capturePlatsa, captureStorageOne, isPlanUrl };
