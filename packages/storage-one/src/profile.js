"use strict";

const { STORAGE_ONE_PLANNERS } = require("@ikea-planner-assets/planner-registry");

const PROFILE_LABELS = Object.freeze(Object.fromEntries(
  STORAGE_ONE_PLANNERS.map(({ slug, label }) => [slug, label]),
));

const PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(PROFILE_LABELS).map(([id, label]) => [id, Object.freeze({
    id,
    label,
    defaultOut: `assets/${id}`,
    defaultNamePrefix: id,
    reportSuffix: `${id}-report.json`,
    catalogSchema: `ikea-planner-assets.${id}-catalog.v1`,
    exportSchema: `ikea-planner-assets.${id}-export.v1`,
  })]),
));

const STORAGE_ONE_PLANNER_IDS = Object.freeze(Object.keys(PROFILES));

function storageOneProfile(value = "platsa") {
  const id = typeof value === "object" && value?.id
    ? String(value.id).toLowerCase()
    : String(value || "platsa").toLowerCase();
  const profile = PROFILES[id];
  if (!profile) throw new Error(`Unsupported Storage One planner: ${value}`);
  return profile;
}

module.exports = { PROFILE_LABELS, PROFILES, STORAGE_ONE_PLANNER_IDS, storageOneProfile };
