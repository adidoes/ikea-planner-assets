"use strict";

const DEFAULT_RETAIL_UNIT = "BE";
const DEFAULT_LANGUAGE = "en";

function parseSkyttaReference(input, options = {}) {
  const supplied = input && typeof input === "object" ? input : {};
  const raw = firstString(
    typeof input === "string" ? input : null,
    supplied.input,
    supplied.url,
    supplied.plannerUrl,
    supplied.code,
    supplied.designCode,
    supplied.configurationId,
    supplied.planId,
  );
  if (!raw) throw new Error("Expected an IKEA SKYTTA planner URL or public design code");

  let parsedUrl = null;
  try { parsedUrl = new URL(raw); } catch {}
  const localeFromPath = parsedUrl ? parsePlannerPath(parsedUrl.pathname) : null;
  const retailUnit = firstString(options.retailUnit, options.country, supplied.retailUnit, supplied.country, localeFromPath?.country, DEFAULT_RETAIL_UNIT).toUpperCase();
  const language = firstString(options.language, supplied.language, localeFromPath?.language, DEFAULT_LANGUAGE).toLowerCase();
  if (!/^[A-Z]{2}$/.test(retailUnit)) throw new Error(`Invalid SKYTTA retail unit: ${retailUnit}`);
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) throw new Error(`Invalid SKYTTA language: ${language}`);

  const planId = normalizeSkyttaCode(firstString(options.planId, options.code, supplied.planId, supplied.code))
    || (parsedUrl ? skyttaCodeFromUrl(parsedUrl) : normalizeSkyttaCode(raw));
  if (!planId) throw new Error(`Could not find a public SKYTTA design code in ${raw}`);

  const country = retailUnit.toLowerCase();
  const origin = parsedUrl?.origin || "https://www.ikea.com";
  const platformIndexUrl = options.platformIndexUrl
    ? new URL(String(options.platformIndexUrl)).href
    : `${origin}/addon-app/skytta/web/latest/${country}/${language}/`;
  const plannerUrl = parsedUrl
    ? parsedUrl.href
    : `${platformIndexUrl}?designCode=${encodeURIComponent(planId)}#/planner`;

  return {
    input: raw,
    code: planId,
    planId,
    retailUnit,
    language,
    locale: firstString(options.locale, supplied.locale, `${language}-${retailUnit}`),
    platformIndexUrl,
    plannerUrl,
  };
}

function skyttaCodeFromUrl(value) {
  const url = value instanceof URL ? value : new URL(String(value));
  const candidates = [
    url.searchParams.get("designCode"),
    url.searchParams.get("configurationId"),
    url.searchParams.get("vpc"),
    url.searchParams.get("code"),
    url.hash.match(/(?:^#|\/)planner\/([A-Za-z0-9_-]+)/i)?.[1],
    url.pathname.match(/\/(?:planner|design|configuration)\/([A-Za-z0-9_-]+)(?:\/|$)/i)?.[1],
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSkyttaCode(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeSkyttaCode(value) {
  if (value == null) return null;
  let decoded;
  try { decoded = decodeURIComponent(String(value)); } catch { decoded = String(value); }
  decoded = decoded.trim().replace(/^#\/?/, "");
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(decoded)) return null;
  return decoded.toUpperCase();
}

function parsePlannerPath(pathname) {
  const match = String(pathname || "").match(/\/addon-app\/skytta\/(?:web|kiosk)\/(?:latest|[^/]+)\/([a-z]{2})\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i);
  return match ? { country: match[1], language: match[2] } : null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

module.exports = {
  DEFAULT_LANGUAGE,
  DEFAULT_RETAIL_UNIT,
  normalizeSkyttaCode,
  parseSkyttaReference,
  skyttaCodeFromUrl,
};
