"use strict";

const assert = require("node:assert/strict");
const { runEnhetSelfTest } = require("@ikea-planner-assets/enhet");
const { runSelfTest: runMethodSelfTest } = require("@ikea-planner-assets/method");
const {
  DEFAULT_PLANNER_SLUG,
  PLANNERS,
  getPlanner,
  normalizePlannerSlug,
  plannerChoiceMessage,
} = require("@ikea-planner-assets/planner-registry");
const { runPaxSelfTest, runPlatsaSelfTest } = require("@ikea-planner-assets/storage-one");
const { runSkyttaSelfTest } = require("@ikea-planner-assets/skytta");
const { runSpaceSelfTest } = require("@ikea-planner-assets/space");
const { runSofaSelfTest } = require("@ikea-planner-assets/sofas/self-test");
const { runSelfTest: runWorktopSelfTest } = require("@ikea-planner-assets/worktop/self-test");

async function runSelfTest() {
  runPlannerRegistrySelfTest();
  await runMethodSelfTest();
  await runEnhetSelfTest();
  await runPlatsaSelfTest();
  await runPaxSelfTest();
  await runSkyttaSelfTest();
  await runSpaceSelfTest();
  await runSofaSelfTest();
  await runWorktopSelfTest();
  console.log("self-test ok");
}

function runPlannerRegistrySelfTest() {
  assert.ok(PLANNERS.some((planner) => planner.slug === DEFAULT_PLANNER_SLUG));
  assert.equal(new Set(PLANNERS.map((planner) => planner.slug)).size, PLANNERS.length);
  assert.equal(new Set(PLANNERS.map((planner) => planner.cli.command)).size, PLANNERS.length);
  for (const planner of PLANNERS) {
    assert.equal(getPlanner(planner.slug), planner);
    assert.equal(normalizePlannerSlug(planner.slug.toUpperCase()), planner.slug);
    assert.ok(planner.label);
    assert.ok(planner.description);
    assert.ok(planner.cli.command.endsWith("-export"));
  }
  assert.equal(normalizePlannerSlug("kitchen"), "method");
  assert.equal(getPlanner("unsupported"), undefined);
  assert.match(plannerChoiceMessage(), /^Choose the .+ planner\.$/);
}

module.exports = { runSelfTest };
