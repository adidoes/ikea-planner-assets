"use strict";

const SOFA_RANGES = Object.freeze([
  "jattebo",
  "kivik",
  "vimle",
  "uppakra",
  "soderhamn",
  "lillehem",
]);

const SOFA_RANGE_SET = new Set(SOFA_RANGES);

function parseSofaReference(input, options = {}, explicitRange = null) {
  if (typeof options === "string") {
    explicitRange = options;
    options = {};
  }
  const supplied = input && typeof input === "object" ? input : {};
  const rawInput = firstString(
    typeof input === "string" ? input : null,
    supplied.url,
    supplied.plannerUrl,
    supplied.code,
    supplied.designCode,
    supplied.configurationId,
    supplied.id,
  );
  if (!rawInput) throw new Error("A public IKEA sofa planner URL or design code is required");

  let parsedUrl = null;
  try {
    parsedUrl = new URL(rawInput);
  } catch {}

  const pathInfo = parsedUrl ? parsePlannerPath(parsedUrl.pathname) : null;
  const requestedRange = normalizeRange(firstString(explicitRange, options.range, supplied.range));
  const urlRange = pathInfo?.range || null;
  if (requestedRange && urlRange && requestedRange !== urlRange) {
    throw new Error(`Sofa range mismatch: URL is ${urlRange}, but ${requestedRange} was requested`);
  }
  const range = requestedRange || urlRange;
  if (!range) {
    throw new Error(`A sofa range is required for a bare design code (${SOFA_RANGES.join(", ")})`);
  }
  assertSupportedRange(range);

  const retailUnit = firstString(options.retailUnit, options.country, supplied.retailUnit, supplied.country, pathInfo?.country, "BE").toUpperCase();
  const language = firstString(options.language, supplied.language, pathInfo?.language, "en").toLowerCase();
  if (!/^[A-Z]{2}$/.test(retailUnit)) throw new Error(`Invalid retail unit: ${retailUnit}`);
  if (!/^[a-z]{2}(?:-[a-z]{2})?$/.test(language)) throw new Error(`Invalid planner language: ${language}`);

  const identifier = extractIdentifier(parsedUrl, rawInput);
  if (!identifier?.code) throw new Error(`Could not find a public design code in: ${rawInput}`);
  const code = normalizeCode(identifier.code);
  const locale = firstString(options.locale, supplied.locale, `${language}-${retailUnit}`);
  const baseUrl = `https://www.ikea.com/addon-app/sofas/${range}/web/latest/${retailUnit.toLowerCase()}/${language}/`;
  const plannerUrl = identifier.kind === "spr"
    ? `${baseUrl}?productId=${encodeURIComponent(code.replace(/^SPR-/i, ""))}`
    : `${baseUrl}#/${encodeURIComponent(code)}`;

  return {
    input: rawInput,
    code,
    kind: identifier.kind,
    range,
    retailUnit,
    language,
    locale,
    plannerUrl,
  };
}

function parsePlannerPath(pathname) {
  const match = String(pathname || "").match(/\/addon-app\/sofas\/([^/]+)\/web\/[^/]+\/([^/]+)\/([^/]+)(?:\/|$)/i);
  if (!match) return null;
  return {
    range: normalizeRange(match[1]),
    country: match[2],
    language: match[3],
  };
}

function extractIdentifier(parsedUrl, rawInput) {
  if (!parsedUrl) {
    const value = String(rawInput).trim();
    if (/^SPR[-_:]/i.test(value)) return { code: value.replace(/^SPR[-_:]*/i, "SPR-"), kind: "spr" };
    return { code: value, kind: "public" };
  }

  for (const key of ["productId", "spr", "itemId"]) {
    const value = parsedUrl.searchParams.get(key);
    if (value) return { code: value, kind: "spr" };
  }
  for (const key of ["vpc", "code", "designCode", "configurationId"]) {
    const value = parsedUrl.searchParams.get(key);
    if (value) return { code: value, kind: "public" };
  }

  let hash = parsedUrl.hash || "";
  try { hash = decodeURIComponent(hash); } catch {}
  hash = hash.replace(/^#\/?/, "").split(/[?&]/, 1)[0];
  const tokens = hash.split("/").filter(Boolean);
  while (tokens.length && /^(?:vpc|design|configuration|config)$/i.test(tokens[0])) tokens.shift();
  const token = tokens.find((value) => /^(?:SPR[-_:]?)?[A-Z0-9]{4,24}$/i.test(value));
  if (!token) return null;
  return {
    code: token,
    kind: /^SPR[-_:]/i.test(token) ? "spr" : "public",
  };
}

function normalizeCode(value) {
  let code = String(value || "").trim().toUpperCase();
  if (/^SPR[-_:]/.test(code)) code = `SPR-${code.replace(/^SPR[-_:]*/, "")}`;
  if (!/^(?:SPR-)?[A-Z0-9]{4,24}$/.test(code)) throw new Error(`Invalid sofa design code: ${value}`);
  return code;
}

function normalizeRange(value) {
  return value == null ? null : String(value).trim().toLowerCase().replace(/[äå]/g, "a").replace(/ö/g, "o");
}

function assertSupportedRange(range) {
  if (!SOFA_RANGE_SET.has(range)) {
    throw new Error(`Unsupported IKEA sofa range: ${range}. Supported ranges: ${SOFA_RANGES.join(", ")}`);
  }
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

module.exports = {
  SOFA_RANGES,
  assertSupportedRange,
  parseSofaReference,
};
