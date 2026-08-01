"use strict";

const { runSelfTest: runMethodSelfTest } = require("@ikea-planner-assets/method");
const { runPaxSelfTest, runPlatsaSelfTest } = require("@ikea-planner-assets/storage-one");

async function runSelfTest() {
  await runMethodSelfTest();
  await runPlatsaSelfTest();
  await runPaxSelfTest();
  console.log("self-test ok");
}

module.exports = { runSelfTest };
