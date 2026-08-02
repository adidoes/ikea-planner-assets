"use strict";

const { extractCatalogProducts, modelKey, optimizedModelUrl } = require("./catalog");
const { capturePax, capturePlatsa, captureStorageOne } = require("./capture");
const { exportGlbObj, exportPaxObj, exportPlatsaObj, exportStorageOneObj } = require("./export-obj");
const { decodeGlb, parseGlb } = require("./glb");
const { collectPaxInstances, collectPlatsaInstances, collectStorageOneInstances, exportPaxPlan, exportPlatsaPlan, exportStorageOnePlan } = require("./pipeline");
const { parsePaxReference, parsePlatsaReference, parseStorageOneReference } = require("./reference");
const { PROFILE_LABELS, PROFILES, STORAGE_ONE_PLANNER_IDS, storageOneProfile } = require("./profile");
const { runPaxSelfTest } = require("./pax-self-test");
const { runPlatsaSelfTest } = require("./platsa-self-test");

module.exports = {
  capturePax,
  capturePlatsa,
  captureStorageOne,
  collectPaxInstances,
  collectPlatsaInstances,
  collectStorageOneInstances,
  decodeGlb,
  exportGlbObj,
  exportPaxObj,
  exportPaxPlan,
  exportPlatsaObj,
  exportPlatsaPlan,
  exportStorageOneObj,
  exportStorageOnePlan,
  extractCatalogProducts,
  modelKey,
  optimizedModelUrl,
  PROFILE_LABELS,
  PROFILES,
  parseGlb,
  parsePaxReference,
  parsePlatsaReference,
  parseStorageOneReference,
  runPaxSelfTest,
  runPlatsaSelfTest,
  STORAGE_ONE_PLANNER_IDS,
  storageOneProfile,
};
