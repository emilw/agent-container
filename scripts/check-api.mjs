#!/usr/bin/env node
// Checks that the tools API stays backwards compatible: everything in main's API must still
// exist, accept the same input and return the same fields. Additions are fine. See the
// COMPATIBILITY RULES next to the registry in agent.mjs.
//
//   node scripts/check-api.mjs main-openapi.json pr-openapi.json
import { readFileSync } from "node:fs";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error("Usage: node scripts/check-api.mjs <main openapi.json> <new openapi.json>");
  process.exit(2);
}
const load = (p) => JSON.parse(readFileSync(p, "utf8"));

const operations = (spec) => Object.fromEntries(
  Object.entries(spec?.paths ?? {}).flatMap(([path, ops]) =>
    Object.entries(ops).map(([method, op]) => [`${method.toUpperCase()} ${path}`, op])));
const params = (op) => Object.fromEntries((op.parameters ?? []).map((p) => [`${p.in} parameter "${p.name}"`, p]));
const body = (op) => op.requestBody?.content?.["application/json"]?.schema ?? { properties: {}, required: [] };
const response = (op) => op.responses?.["200"]?.content?.["application/json"]?.schema?.properties ?? {};

const problems = [];

function compareSchema(where, before, after) {
  if (before.type !== after.type) problems.push(`${where}: type changed from ${before.type} to ${after.type}`);
  if (before.items?.type !== after.items?.type) problems.push(`${where}: item type changed from ${before.items?.type} to ${after.items?.type}`);
  const lost = (before.enum ?? []).filter((v) => !after.enum?.includes(v));
  if (before.enum && lost.length) problems.push(`${where}: no longer accepts ${lost.join(", ")}`);
  if (!before.enum && after.enum) problems.push(`${where}: now only accepts ${after.enum.join(", ")}`);
}

const before = operations(load(beforePath));
const now = operations(load(afterPath));

for (const [key, old] of Object.entries(before)) {
  const op = now[key];
  const name = `${key} (${old.operationId})`;
  if (!op) {
    problems.push(`${name} was removed. Keep it, or mark it deprecated and add a /v2/ version.`);
    continue;
  }
  if (op.operationId !== old.operationId) {
    problems.push(`${name}: operationId changed to ${op.operationId}; it is also the MCP tool name and the agent-tools command`);
  }
  if (old["x-mcp-tool"] && !op["x-mcp-tool"]) problems.push(`${name}: the MCP tool ${old["x-mcp-tool"]} was removed`);

  const oldParams = params(old);
  const newParams = params(op);
  for (const [p, def] of Object.entries(oldParams)) {
    if (!newParams[p]) { problems.push(`${name}: ${p} was removed`); continue; }
    compareSchema(`${name} ${p}`, def.schema ?? {}, newParams[p].schema ?? {});
    if (!def.required && newParams[p].required) problems.push(`${name}: ${p} became required`);
  }
  for (const [p, def] of Object.entries(newParams)) {
    if (!oldParams[p] && def.required) problems.push(`${name}: new required ${p}; new inputs must be optional`);
  }

  const oldBody = body(old);
  const newBody = body(op);
  for (const [field, schema] of Object.entries(oldBody.properties ?? {})) {
    const next = newBody.properties?.[field];
    if (!next) { problems.push(`${name}: body field "${field}" was removed`); continue; }
    compareSchema(`${name} body field "${field}"`, schema, next);
  }
  for (const field of newBody.required ?? []) {
    if (!(oldBody.required ?? []).includes(field)) problems.push(`${name}: body field "${field}" is now required; new inputs must be optional`);
  }

  const oldResponse = response(old);
  const newResponse = response(op);
  for (const [field, schema] of Object.entries(oldResponse)) {
    if (field === "ok") continue;
    if (!newResponse[field]) { problems.push(`${name}: response field "${field}" was removed`); continue; }
    compareSchema(`${name} response field "${field}"`, schema, newResponse[field]);
  }
}

const added = Object.keys(now).filter((k) => !before[k]).map((k) => `${k} (${now[k].operationId})`);
if (added.length) console.log(`New compared with main:\n  ${added.join("\n  ")}`);
if (problems.length) {
  console.error(`\nBreaking changes to the tools API compared with main:\n  ${problems.join("\n  ")}`);
  console.error("\nExisting endpoints and MCP tools must keep working. Extend them compatibly, or add a /v2/ version (see agent.mjs).");
  process.exit(1);
}
console.log("\nThe tools API is compatible with main.");
