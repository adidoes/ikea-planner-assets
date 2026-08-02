"use strict";

const { decodeWorktopConfiguration, parseMeasurementString } = require("./configuration");
const { writeWorktopObj } = require("./export-obj");
const { buildWorktopGeometry, footprintsForShape, triangulatePolygon } = require("./geometry");
const { fetchWorktopConfiguration, parseWorktopReference } = require("./reference");

async function exportWorktopPlan(input, options = {}) {
  let reference;
  let payload;
  let url = null;
  if (isConfigurationPayload(input)) {
    payload = input;
    reference = referenceForPayload(input, options);
  } else {
    const fetched = await fetchWorktopConfiguration(input, options);
    ({ reference, payload, url } = fetched);
  }
  const plan = decodeWorktopConfiguration(payload);
  const geometry = buildWorktopGeometry(plan, options);
  return writeWorktopObj(geometry, plan, { reference, url }, options);
}

function isConfigurationPayload(input) {
  return !!input && typeof input === "object" && String(input.application || "").toUpperCase() === "CWCALC" && input.configuration;
}

function referenceForPayload(payload, options) {
  const code = payload.configurationId || options.configurationId || null;
  const country = options.country ? String(options.country).toUpperCase() : null;
  const language = options.language ? String(options.language).toLowerCase() : null;
  return {
    code,
    country,
    language,
    locale: country && language ? `${language}-${country}` : null,
    source: "payload",
    inputUrl: null,
  };
}

module.exports = {
  buildWorktopGeometry,
  decodeWorktopConfiguration,
  exportWorktopPlan,
  fetchWorktopConfiguration,
  footprintsForShape,
  parseMeasurementString,
  parseWorktopReference,
  triangulatePolygon,
};
