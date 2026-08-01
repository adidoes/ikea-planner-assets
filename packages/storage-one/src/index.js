"use strict";

const { extractCatalogProducts, modelKey, optimizedModelUrl } = require("./catalog");
const { capturePax, capturePlatsa, captureStorageOne } = require("./capture");
const { exportPaxObj, exportPlatsaObj, exportStorageOneObj } = require("./export-obj");
const { decodeGlb, parseGlb } = require("./glb");
const { collectPaxInstances, collectPlatsaInstances, collectStorageOneInstances, exportPaxPlan, exportPlatsaPlan, exportStorageOnePlan } = require("./pipeline");
const { parsePaxReference, parsePlatsaReference, parseStorageOneReference } = require("./reference");
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
  exportPaxObj,
  exportPaxPlan,
  exportPlatsaObj,
  exportPlatsaPlan,
  exportStorageOneObj,
  exportStorageOnePlan,
  extractCatalogProducts,
  modelKey,
  optimizedModelUrl,
  parseGlb,
  parsePaxReference,
  parsePlatsaReference,
  parseStorageOneReference,
  runPaxSelfTest,
  runPlatsaSelfTest,
};
