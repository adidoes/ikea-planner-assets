"use strict";

const DEFAULT_RETAIL_UNIT = "BE";
const DEFAULT_LANGUAGE = "en";

function parseEnhetReference(input, options = {}) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("Expected an ENHET share URL or public design code");

  let retailUnit = String(options.retailUnit || DEFAULT_RETAIL_UNIT).toUpperCase();
  let language = String(options.language || DEFAULT_LANGUAGE).toLowerCase();
  let sourceUrl = null;
  let planId = null;

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    sourceUrl = url.href;
    const locale = url.pathname.match(/\/addon-app\/coro3\/planner\/(?:latest|[^/]+)\/([a-z]{2})\/([a-z]{2})(?:\/|$)/i);
    if (locale) {
      retailUnit = locale[1].toUpperCase();
      language = locale[2].toLowerCase();
    }
    planId = firstPlanId([
      url.hash.match(/(?:^#|\/)vpc\/([^/?#]+)/i)?.[1],
      url.searchParams.get("designCode"),
      url.searchParams.get("vpc"),
      url.pathname.match(/\/vpc\/([^/?#]+)/i)?.[1],
    ]);
  } else {
    planId = normalizePlanId(raw);
  }

  if (!planId) throw new Error(`Could not find an ENHET design code in ${raw}`);
  const country = retailUnit.toLowerCase();
  const plannerIndexUrl = `https://www.ikea.com/addon-app/coro3/planner/latest/${country}/${language}/`;
  return {
    input: raw,
    planId,
    retailUnit,
    language,
    locale: `${language}-${retailUnit}`,
    plannerIndexUrl,
    plannerUrl: `${plannerIndexUrl}#/vpc/${planId}`,
    sourceUrl,
  };
}

function firstPlanId(values) {
  for (const value of values) {
    const normalized = normalizePlanId(value);
    if (normalized) return normalized;
  }
  return null;
}

function normalizePlanId(value) {
  if (value == null) return null;
  const normalized = decodeURIComponent(String(value)).trim();
  return /^[A-Za-z0-9_-]{4,64}$/.test(normalized) ? normalized.toUpperCase() : null;
}

module.exports = { DEFAULT_LANGUAGE, DEFAULT_RETAIL_UNIT, normalizePlanId, parseEnhetReference };
