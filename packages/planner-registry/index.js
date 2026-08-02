"use strict";

const STORAGE_ONE_PLANNERS = Object.freeze([
  ["besta", "BESTÅ", "Storage planner"],
  ["billy", "BILLY", "Bookcase planner"],
  ["boaxel", "BOAXEL", "Wall storage planner"],
  ["bror", "BROR", "Utility storage planner"],
  ["eket", "EKET", "Cabinet planner"],
  ["elvarli", "ELVARLI", "Open storage planner"],
  ["ivar", "IVAR", "Storage planner"],
  ["jonaxel", "JONAXEL", "Storage planner"],
  ["kallax", "KALLAX", "Shelf planner"],
  ["knoxhult", "KNOXHULT", "Kitchen planner"],
  ["ladmakare", "LÅDMAKARE", "Storage planner"],
  ["lastare", "LASTARE", "Storage planner"],
  ["pax", "PAX", "Wardrobe planner"],
  ["platsa", "PLATSA", "Storage planner"],
  ["smastad", "SMÅSTAD", "Children's storage planner"],
].map(([slug, label, description]) => planner({
  slug,
  label,
  description,
  family: "storage",
  cli: {
    command: `${slug}-export`,
    adapter: "storage-one",
    exporter: "exportStorageOnePlan",
    profile: slug,
    defaultOutput: `assets/${slug}`,
  },
})));

const SPACE_PLANNERS = Object.freeze([
  ["outdoor", "Outdoor", "Outdoor space planner"],
  ["bathroom", "Bathroom", "Bathroom planner"],
  ["dining-room", "Dining room", "Room planner"],
  ["hallway", "Hallway", "Room planner"],
  ["childrens-room", "Children's room", "Room planner"],
  ["bedroom", "Bedroom", "Room planner"],
  ["living-room", "Living room", "Room planner"],
  ["home-office", "Home office", "Room planner"],
  ["dining-chair", "Dining chair", "Product configurator"],
  ["dining-table", "Dining table", "Product configurator"],
  ["dining-set", "Dining set", "Product configurator"],
  ["desk", "Desk", "Product configurator"],
  ["mittzon", "MITTZON", "Desk configurator"],
].map(([slug, label, description]) => planner({
  slug,
  label,
  description,
  family: "space",
  cli: {
    command: `${slug}-export`,
    adapter: "space",
    exporter: "exportSpacePlan",
    defaultOutput: `assets/${slug}`,
  },
})));

const SOFA_PLANNERS = Object.freeze([
  ["jattebo", "JÄTTEBO"],
  ["kivik", "KIVIK"],
  ["vimle", "VIMLE"],
  ["uppakra", "UPPÅKRA"],
  ["soderhamn", "SÖDERHAMN"],
  ["lillehem", "LILLEHEM"],
].map(([slug, label]) => planner({
  slug,
  label,
  description: "Sofa planner",
  family: "sofas",
  cli: {
    command: `${slug}-export`,
    adapter: "sofas",
    exporter: "exportSofaPlan",
    profile: slug,
    defaultOutput: `assets/${slug}`,
  },
})));

const PLANNERS = Object.freeze([
  ...STORAGE_ONE_PLANNERS,
  ...SPACE_PLANNERS,
  ...SOFA_PLANNERS,
  planner({
    slug: "enhet",
    label: "ENHET",
    description: "Kitchen planner",
    family: "kitchen",
    cli: {
      command: "enhet-export",
      adapter: "enhet",
      exporter: "exportEnhetPlan",
      defaultOutput: "assets/enhet",
    },
  }),
  planner({
    slug: "method",
    aliases: ["kitchen"],
    label: "METHOD",
    description: "Kitchen planner",
    family: "kitchen",
    cli: {
      command: "method-export",
      adapter: "method",
      exporter: "exportMethodPlan",
      defaultOutput: "assets/method",
      defaultName: "ikea-method-kitchen",
    },
  }),
  planner({
    slug: "worktop",
    aliases: ["custom-worktop"],
    label: "Custom worktop",
    description: "Worktop calculator",
    family: "worktop",
    cli: {
      command: "worktop-export",
      adapter: "worktop",
      exporter: "exportWorktopPlan",
      defaultOutput: "assets/worktop",
    },
  }),
  planner({
    slug: "skytta",
    label: "SKYTTA",
    description: "Sliding-door planner",
    family: "storage",
    cli: {
      command: "skytta-export",
      adapter: "skytta",
      exporter: "exportSkyttaPlan",
      defaultOutput: "assets/skytta",
    },
  }),
]);

const DEFAULT_PLANNER_SLUG = "platsa";
const PLANNERS_BY_SLUG = new Map(PLANNERS.map((entry) => [entry.slug, entry]));
const PLANNER_ALIASES = new Map(
  PLANNERS.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.slug])),
);

function planner(definition) {
  return Object.freeze({
    ...definition,
    aliases: Object.freeze([...(definition.aliases || [])]),
    cli: Object.freeze({ ...definition.cli }),
  });
}

function normalizePlannerSlug(value) {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return undefined;
  if (PLANNERS_BY_SLUG.has(candidate)) return candidate;
  return PLANNER_ALIASES.get(candidate);
}

function getPlanner(value) {
  const slug = normalizePlannerSlug(value);
  return slug ? PLANNERS_BY_SLUG.get(slug) : undefined;
}

function plannerChoiceMessage() {
  const labels = PLANNERS.map((entry) => entry.label);
  if (labels.length === 1) return `Choose the ${labels[0]} planner.`;
  return `Choose the ${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)} planner.`;
}

module.exports = {
  DEFAULT_PLANNER_SLUG,
  PLANNERS,
  SOFA_PLANNERS,
  SPACE_PLANNERS,
  STORAGE_ONE_PLANNERS,
  getPlanner,
  normalizePlannerSlug,
  plannerChoiceMessage,
};
