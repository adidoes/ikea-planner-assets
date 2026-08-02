"use strict";

const {
  fetchSpaceCatalogs,
  findCatalogProduct,
  normalizeSpaceCatalog,
  normalizeSpaceProduct,
  spaceCatalogUrl,
} = require("./catalog");
const {
  configurationUrl,
  discoverDexfApiKey,
  extractDexfApiKey,
  extractScriptUrls,
  fetchDexfConfiguration,
} = require("./dexf");
const {
  analyzeSpaceEntities,
  captureSpacePlan,
  collectSpaceInstances,
  exportSpaceObj,
  exportSpacePlan,
  fetchSpaceModel,
  resolveSpaceModels,
} = require("./pipeline");
const { parseSpaceReference, planIdFromSpaceUrl } = require("./reference");
const { runSpaceSelfTest } = require("./space-self-test");

module.exports = {
  analyzeSpaceEntities,
  captureSpacePlan,
  collectSpaceInstances,
  configurationUrl,
  discoverDexfApiKey,
  exportSpaceObj,
  exportSpacePlan,
  extractDexfApiKey,
  extractScriptUrls,
  fetchDexfConfiguration,
  fetchSpaceCatalogs,
  fetchSpaceModel,
  findCatalogProduct,
  normalizeSpaceCatalog,
  normalizeSpaceProduct,
  parseSpaceReference,
  planIdFromSpaceUrl,
  resolveSpaceModels,
  runSpaceSelfTest,
  spaceCatalogUrl,
};
