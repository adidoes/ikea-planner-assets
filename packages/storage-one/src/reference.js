"use strict";

const { storageOneProfile } = require("./profile");

const DEFAULT_RETAIL_UNIT = "BE";
const DEFAULT_LANGUAGE = "en";

function parsePlatsaReference(input, options = {}) {
  return parseStorageOneReference(input, options, "platsa");
}

function parsePaxReference(input, options = {}) {
  return parseStorageOneReference(input, options, "pax");
}

function parseStorageOneReference(input, options = {}, planner = "platsa") {
  const profile = storageOneProfile(planner);
  const raw = String(input || "").trim();
  if (!raw) throw new Error(`Expected a ${profile.label} share URL or plan id`);

  const fallbackRetailUnit = String(options.retailUnit || DEFAULT_RETAIL_UNIT).toUpperCase();
  const fallbackLanguage = String(options.language || DEFAULT_LANGUAGE).toLowerCase();
  let planId = null;
  let retailUnit = fallbackRetailUnit;
  let language = fallbackLanguage;
  let sourceUrl = null;

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    sourceUrl = url.href;
    const localeMatch = url.pathname.match(new RegExp(`/storageone/${profile.id}/(?:web|kiosk)/[^/]+/([a-z]{2})/([a-z]{2})(?:/|$)`, "i"));
    if (localeMatch) {
      retailUnit = localeMatch[1].toUpperCase();
      language = localeMatch[2].toLowerCase();
    }
    planId = planIdFromUrl(url);
  } else {
    planId = normalizePlanId(raw);
  }

  if (!planId) {
    throw new Error(`Could not find a ${profile.label} plan id in ${raw}`);
  }

  const country = retailUnit.toLowerCase();
  const plannerUrl = sourceUrl || `https://www.ikea.com/addon-app/storageone/${profile.id}/web/latest/${country}/${language}/?vpcSource=clipboard#/vpc/${planId}`;
  return {
    input: raw,
    planId,
    retailUnit,
    language,
    locale: `${language}-${retailUnit}`,
    plannerUrl,
  };
}

function planIdFromUrl(url) {
  const candidates = [
    url.hash.match(/(?:^#|\/)vpc\/([^/?#]+)/i)?.[1],
    url.hash.match(/(?:^#|\/)u\/([^/?#]+)/i)?.[1],
    url.searchParams.get("vpc"),
    url.searchParams.get("designId"),
    url.pathname.match(/\/(?:vpc|u)\/([^/?#]+)/i)?.[1],
  ];
  for (const candidate of candidates) {
    const normalized = normalizePlanId(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizePlanId(value) {
  if (value == null) return null;
  const decoded = decodeURIComponent(String(value)).trim().replace(/^#\/?/, "");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(decoded)) return null;
  return decoded.toUpperCase();
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_RETAIL_UNIT,
  normalizePlanId,
  parsePaxReference,
  parsePlatsaReference,
  parseStorageOneReference,
  planIdFromUrl,
};
