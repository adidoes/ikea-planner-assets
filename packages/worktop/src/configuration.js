"use strict";

const OPERATION_PARAMETERS = [
  "cutout",
  "freestandingHob",
  "roundedCorner",
  "invertedCorner",
  "singleCut",
  "doubleCut",
  "tripleCut",
  "highCabinetJoint",
  "tapHole",
  "wallPanelRoundCutSmall",
  "wallPanelRoundCutBig",
  "wallPanelSquareCut",
  "wallPanelSingleCut",
  "wallPanelDoubleCut",
  "wallPanelTripleCut",
  "kitchenIslandSingleCut",
  "kitchenIslandRoundedCorner",
  "kitchenIslandSquareCut",
];

function decodeWorktopConfiguration(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Expected an IKEA worktop configuration response object");
  if (String(payload.application || "").toUpperCase() !== "CWCALC") {
    throw new Error("Configuration application must be cwcalc");
  }
  let content = payload.configuration?.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch (error) {
      throw new Error("Worktop configuration.content is not valid JSON", { cause: error });
    }
  }
  if (!content || !Array.isArray(content.parameters) || !content.measurements) {
    throw new Error("Worktop configuration is missing parameters or measurements");
  }

  const parameterEntries = content.parameters.map((entry) => ({
    name: String(entry?.name || ""),
    value: entry?.value,
  })).filter((entry) => entry.name);
  const parameters = {};
  for (const entry of parameterEntries) parameters[entry.name] = entry.value;
  const measurements = numericMeasurements(content.measurements, "measurements");
  const shape = String(parameters.shape || "rectangular");
  const thicknessMm = positiveNumber(parameters.thickness, "thickness");
  const operations = collectOperations(parameters);
  const hasIsland = parameters.kitchenIsland && !["none", "no-kitchen-island", "false"].includes(String(parameters.kitchenIsland));
  const islandMeasurements = hasIsland
    ? parseMeasurementString(parameters.kitchenIslandMeasurements, "kitchenIslandMeasurements")
    : null;

  return {
    configurationId: payload.configurationId || null,
    application: payload.application,
    applicationName: payload.applicationName || null,
    configurationVersion: payload.configuration?.version || null,
    itemList: Array.isArray(payload.itemList?.item) ? payload.itemList.item : [],
    parameterEntries,
    parameters,
    measurements,
    main: {
      shape,
      flipped: booleanValue(parameters.shapeFlipped),
      thicknessMm,
      material: parameters.material || null,
      expression: parameters.expression || null,
      edge: parameters.edge || null,
      wallLocation: parameters.wallLocation || null,
    },
    island: hasIsland ? {
      shape: "rectangular",
      flipped: booleanValue(parameters.kitchenIslandFlipped),
      thicknessMm: positiveNumber(parameters.kitchenIslandThickness || parameters.thickness, "kitchenIslandThickness"),
      material: parameters.kitchenIslandMaterial || parameters.material || null,
      expression: parameters.kitchenIslandExpression || parameters.expression || null,
      edge: parameters.kitchenIslandEdge || parameters.edge || null,
      wallLocation: parameters.kitchenIslandWallLocation || null,
      measurements: islandMeasurements,
    } : null,
    operations,
    image: Array.isArray(payload.image) ? payload.image : [],
  };
}

function numericMeasurements(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = Number(raw);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}.${key} must be a positive number`);
    result[key.toLowerCase()] = number;
  }
  return result;
}

function parseMeasurementString(value, label) {
  if (value && typeof value === "object") return numericMeasurements(value, label);
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  const result = {};
  for (const part of value.split("-")) {
    const match = part.match(/^([a-z])\s*:\s*(\d+(?:\.\d+)?)$/i);
    if (!match) throw new Error(`Could not parse ${label}: ${value}`);
    result[match[1].toLowerCase()] = Number(match[2]);
  }
  return numericMeasurements(result, label);
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}

function booleanValue(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function collectOperations(parameters) {
  const operations = [];
  if (parameters.sinkMaterial && parameters.sinkMaterial !== "noSink") {
    operations.push({
      name: "sink",
      count: 1,
      selection: parameters.sinkModel || parameters.sink || parameters.sinkMaterial,
      fastening: parameters.sinkFastening || null,
      target: "main",
    });
  }
  for (const name of OPERATION_PARAMETERS) {
    const count = Number(parameters[name] || 0);
    if (Number.isFinite(count) && count > 0) {
      operations.push({
        name,
        count,
        target: name.startsWith("kitchenIsland") ? "island" : name.startsWith("wallPanel") ? "wall-panel" : "main",
        widthMm: name === "freestandingHob" && parameters.freestandingHobMeasurements
          ? parseMeasurementString(parameters.freestandingHobMeasurements, "freestandingHobMeasurements").width || null
          : null,
      });
    }
  }
  return operations;
}

module.exports = {
  decodeWorktopConfiguration,
  parseMeasurementString,
};
