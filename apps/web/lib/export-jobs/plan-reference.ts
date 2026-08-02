const CODE_PATTERN = /^[a-z0-9_-]{4,64}$/i;

export function extractPlanId(sourceUrl?: string): string | null {
  if (!sourceUrl) return null;
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }

  const hash = decodeHash(url.hash);
  const hashQuery = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "");
  const candidates = [
    url.searchParams.get("designCode"),
    url.searchParams.get("configurationId"),
    url.searchParams.get("vpc"),
    url.searchParams.get("code"),
    url.searchParams.get("id"),
    url.searchParams.get("projectId"),
    hashQuery.get("designCode"),
    hashQuery.get("configurationId"),
    hashQuery.get("vpc"),
    hashQuery.get("code"),
    hash.match(/(?:^|\/)(?:vpc|open|design|planner|u|designId)\/([^/?#]+)/i)?.[1],
    hash.match(/^\/?([^/?#]+)\/?(?:\?|$)/)?.[1],
    url.pathname.match(/\/(?:vpc|open|design|planner|u|designId)\/([^/?#]+)/i)?.[1],
  ];

  for (const candidate of candidates) {
    const code = normalizeCode(candidate);
    if (code) return code;
  }
  return null;
}

function decodeHash(value: string): string {
  try {
    return decodeURIComponent(value.replace(/^#/, ""));
  } catch {
    return value.replace(/^#/, "");
  }
}

function normalizeCode(value: string | null | undefined): string | null {
  const code = value?.trim();
  return code && CODE_PATTERN.test(code) ? code.toUpperCase() : null;
}
