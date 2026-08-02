"use strict";

const API_BASE = "https://api.dexf.ikea.com/vpc/v1/configurations";
// This is a public client identifier embedded in cwcalc 4.7.10.5. Callers can
// override it with options.apiKey if IKEA rotates the published value.
const PUBLIC_DEXF_API_KEY = "9aebdb58-fad2-4569-90bd-0d4a8fd9903c";
const CODE_PATTERN = /^[A-Z0-9_-]{4,64}$/i;

function parseWorktopReference(input, options = {}) {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const code = input.code || input.configurationId;
    if (!code) throw new Error("Worktop reference object requires code or configurationId");
    return normalizeReference({
      code,
      country: input.country || options.country,
      language: input.language || options.language,
      source: "object",
    });
  }

  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Expected an IKEA Custom Worktop Calculator code or saved-design link");
  }

  const value = input.trim();
  if (CODE_PATTERN.test(value)) {
    return normalizeReference({
      code: value,
      country: options.country,
      language: options.language,
      source: "code",
    });
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Could not parse worktop reference: ${value}`);
  }

  const pathSegments = splitSegments(url.pathname);
  const hashText = decodeURIComponent(url.hash.replace(/^#/, ""));
  const hashPath = hashText.split("?")[0];
  const hashSegments = splitSegments(hashPath);
  const hashQuery = new URLSearchParams(hashText.includes("?") ? hashText.slice(hashText.indexOf("?") + 1) : "");
  const code = url.searchParams.get("code")
    || hashQuery.get("code")
    || findCodeSegment(hashSegments)
    || findCodeSegment(pathSegments);
  const locale = findLocale(pathSegments) || findLocale(hashSegments) || {};

  if (!code) {
    throw new Error("The calculator link does not contain a saved worktop code");
  }
  return normalizeReference({
    code,
    country: options.country || locale.country,
    language: options.language || locale.language,
    source: "url",
    inputUrl: url.href,
  });
}

function findLocale(segments) {
  for (let i = 0; i + 1 < segments.length; i++) {
    if (/^[a-z]{2}$/i.test(segments[i]) && /^[a-z]{2,3}$/i.test(segments[i + 1])) {
      return { country: segments[i], language: segments[i + 1] };
    }
  }
  return null;
}

function findCodeSegment(segments) {
  const candidates = segments.filter((segment) => CODE_PATTERN.test(segment));
  return candidates.find((segment) => /\d/.test(segment) && segment.length >= 6) || null;
}

function normalizeReference(reference) {
  const code = String(reference.code || "").trim().toUpperCase();
  const country = String(reference.country || "").trim().toUpperCase();
  const language = String(reference.language || "").trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new Error(`Invalid worktop configuration code: ${code}`);
  if (!/^[A-Z]{2}$/.test(country) || !/^[a-z]{2,3}$/.test(language)) {
    throw new Error("A bare worktop code requires options.country and options.language; saved IKEA links normally contain both");
  }
  return {
    code,
    country,
    language,
    locale: `${language}-${country}`,
    source: reference.source || "unknown",
    inputUrl: reference.inputUrl || null,
  };
}

function configurationUrl(reference, apiBase = API_BASE) {
  const base = String(apiBase).replace(/\/+$/, "");
  return `${base}/retailunit/${encodeURIComponent(reference.country)}/locale/${encodeURIComponent(reference.locale)}/${encodeURIComponent(reference.code)}`;
}

async function fetchWorktopConfiguration(referenceInput, options = {}) {
  const reference = referenceInput && referenceInput.locale
    ? referenceInput
    : parseWorktopReference(referenceInput, options);
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetchWorktopConfiguration requires a Fetch-compatible implementation");
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs == null ? 20_000 : Number(options.timeoutMs);
  let timeout;
  let onAbort;
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

  const url = configurationUrl(reference, options.apiBase);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        "DEXF-API-KEY": options.apiKey || PUBLIC_DEXF_API_KEY,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const suffix = response.status === 404 ? " (code not found for this market/locale)" : "";
      throw new Error(`IKEA worktop configuration request failed with HTTP ${response.status}${suffix}`);
    }
    const payload = await response.json();
    if (String(payload?.application || "").toUpperCase() !== "CWCALC") {
      throw new Error("The saved code is not a Custom Worktop Calculator configuration");
    }
    return { reference, payload, url };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error(`IKEA worktop configuration request timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (options.signal && onAbort) options.signal.removeEventListener("abort", onAbort);
  }
}

function splitSegments(value) {
  return String(value || "").split("/").map((segment) => segment.trim()).filter(Boolean);
}

module.exports = {
  API_BASE,
  configurationUrl,
  fetchWorktopConfiguration,
  parseWorktopReference,
};
