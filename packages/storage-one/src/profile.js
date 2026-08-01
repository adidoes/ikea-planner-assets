"use strict";

const PROFILES = Object.freeze({
  platsa: Object.freeze({
    id: "platsa",
    label: "PLATSA",
    defaultOut: "assets/platsa",
    defaultNamePrefix: "platsa",
    reportSuffix: "platsa-report.json",
    catalogSchema: "ikea-planner-assets.platsa-catalog.v1",
    exportSchema: "ikea-planner-assets.platsa-export.v1",
  }),
  pax: Object.freeze({
    id: "pax",
    label: "PAX",
    defaultOut: "assets/pax",
    defaultNamePrefix: "pax",
    reportSuffix: "pax-report.json",
    catalogSchema: "ikea-planner-assets.pax-catalog.v1",
    exportSchema: "ikea-planner-assets.pax-export.v1",
  }),
});

function storageOneProfile(value = "platsa") {
  const id = typeof value === "object" && value?.id
    ? String(value.id).toLowerCase()
    : String(value || "platsa").toLowerCase();
  const profile = PROFILES[id];
  if (!profile) throw new Error(`Unsupported Storage One planner: ${value}`);
  return profile;
}

module.exports = { PROFILES, storageOneProfile };
