"use strict";

const DEFAULT_RETAIL_UNIT = "BE";
const DEFAULT_LANGUAGE = "en";

function parseSpaceReference(input, options = {}) {
  if (input && typeof input === "object" && input.planId) {
    return parseSpaceReference(input.input || input.plannerUrl || input.planId, { ...input, ...options });
  }

  const raw = String(input || "").trim();
  if (!raw) throw new Error("Expected an IKEA Space share URL or public design code");

  let retailUnit = String(options.retailUnit || DEFAULT_RETAIL_UNIT).toUpperCase();
  let language = String(options.language || DEFAULT_LANGUAGE).toLowerCase();
  let sourceUrl = null;
  let planId = normalizePlanId(options.planId);

  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    sourceUrl = url.href;
    const localeMatch = url.pathname.match(/\/addon-app\/space\/platform\/(?:latest|releases\/[^/]+\/[^/]+)\/([a-z]{2})\/([a-z]{2})(?:\/|$)/i);
    if (localeMatch) {
      retailUnit = localeMatch[1].toUpperCase();
      language = localeMatch[2].toLowerCase();
    }
    planId ||= planIdFromSpaceUrl(url);
  } else {
    planId ||= normalizePlanId(raw);
  }

  if (!planId) throw new Error(`Could not find an IKEA Space design code in ${raw}`);

  const country = retailUnit.toLowerCase();
  const origin = sourceUrl ? new URL(sourceUrl).origin : "https://www.ikea.com";
  const platformIndexUrl = options.platformIndexUrl
    ? new URL(String(options.platformIndexUrl)).href
    : `${origin}/addon-app/space/platform/latest/${country}/${language}/`;
  const plannerUrl = sourceUrl && /\/(?:open|summary)\//i.test(new URL(sourceUrl).hash)
    ? sourceUrl
    : `${platformIndexUrl}?vpcSource=clipboard#/open/${planId}`;

  return {
    input: raw,
    planId,
    retailUnit,
    language,
    locale: `${language}-${retailUnit}`,
    platformIndexUrl,
    plannerUrl,
  };
}

function planIdFromSpaceUrl(url) {
  const candidates = [
    url.hash.match(/(?:^#|\/)open\/([^/?#]+)/i)?.[1],
    url.hash.match(/(?:^#|\/)summary\/([^/?#]+)/i)?.[1],
    url.searchParams.get("designCode"),
    url.searchParams.get("configurationId"),
    url.searchParams.get("vpc"),
    url.searchParams.get("designId"),
    url.pathname.match(/\/(?:open|summary|vpc)\/([^/?#]+)/i)?.[1],
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
  parseSpaceReference,
  planIdFromSpaceUrl,
};
