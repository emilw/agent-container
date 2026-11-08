#!/usr/bin/env node
// Tests the issue flow's step decision (decide() in sdd.mjs) against fixed GitHub data, with
// no network. Run: node scripts/test-sdd.mjs
import { decide, stepOf, LABEL_BLOCKED, LABEL_START } from "../sdd.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const QUIET = 15 * 60_000;
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const ENABLED = "2026-11-01T00:00:00Z";

const issue = (o = {}) => ({ number: 7, title: "Add webhooks", state: "open", stateReason: null, labels: [], createdAt: "2026-11-05T10:00:00Z", authorCanWrite: true, ...o });
const sub = (number, step, state = "open", stateReason = null) => ({ number, step, title: `${step}: Add webhooks`, state, stateReason });
const comment = (o = {}) => ({ id: 100, on: "#16", author: "owner", createdAt: ago(30), body: "please change X", canWrite: true, byFlow: false, ...o });
const facts = (o = {}) => ({ issue: issue(o.issue), subs: o.subs ?? [], pr: o.pr ?? null, comments: o.comments ?? [], now: NOW, quietMs: QUIET, enabledAt: ENABLED, busy: o.busy ?? false });
const tracked = (o = {}) => ({ number: 7, step: "triage", runs: 1, lastCommentId: 50, ...o });

const cases = [
  ["new issue by the owner starts triage", undefined, facts(), "run triage"],
  ["new issue by someone without write access waits", undefined, facts({ issue: { authorCanWrite: false } }), "none"],
  ["their issue with the sdd label starts", undefined, facts({ issue: { authorCanWrite: false, labels: [LABEL_START] } }), "run triage"],
  ["issue opened before the flow was turned on waits", undefined, facts({ issue: { createdAt: "2026-10-01T00:00:00Z" } }), "none"],
  ["...and starts with the sdd label", undefined, facts({ issue: { createdAt: "2026-10-01T00:00:00Z", labels: [LABEL_START] } }), "run triage"],
  ["closed untracked issue is ignored", undefined, facts({ issue: { state: "closed" } }), "none"],
  ["open spec without comments waits for review", tracked(), facts({ subs: [sub(15, "functional spec")] }), "none"],
  ["owner feedback, quiet for long enough, revises", tracked(), facts({ subs: [sub(15, "functional spec")], comments: [comment()] }), "run revise"],
  ["owner feedback still coming waits, and rechecks", tracked(), facts({ subs: [sub(15, "functional spec")], comments: [comment({ createdAt: ago(5) })] }), "none recheck"],
  ["the agent's own comments never trigger", tracked(), facts({ subs: [sub(15, "functional spec")], comments: [comment({ byFlow: true })] }), "none"],
  ["comments without write access never trigger", tracked(), facts({ subs: [sub(15, "functional spec")], comments: [comment({ canWrite: false })] }), "none"],
  ["approved functional spec → technical spec", tracked(), facts({ subs: [sub(15, "functional spec", "closed", "completed")] }), "run write technical spec"],
  ["approved technical spec → implementation", tracked(), facts({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", "closed", "completed")] }), "run implement"],
  ["approved fix plan → implementation", tracked(), facts({ subs: [sub(12, "fix plan", "closed", "completed")] }), "run implement"],
  ["rejected spec stops the flow", tracked(), facts({ subs: [sub(15, "functional spec", "closed", "not_planned")] }), "finish Stopped"],
  ["open pull request without comments waits", tracked({ pr: 18 }), facts({ subs: [sub(16, "technical spec", "closed", "completed"), sub(17, "implementation")], pr: { number: 18, state: "open" } }), "none"],
  ["feedback on the pull request revises it", tracked({ pr: 18 }), facts({ subs: [sub(17, "implementation")], pr: { number: 18, state: "open" }, comments: [comment({ on: "pull request" })] }), "run revise-pr"],
  ["merged and closed is done", tracked({ pr: 18 }), facts({ issue: { state: "closed" }, pr: { number: 18, state: "closed", merged: true } }), "finish Done"],
  ["closed without a merge is closed", tracked(), facts({ issue: { state: "closed" } }), "finish Closed"],
  ["blocked does nothing", tracked(), facts({ issue: { labels: [LABEL_BLOCKED] }, subs: [sub(15, "functional spec", "closed", "completed")] }), "none"],
  ["label removed reruns the blocked step", tracked({ blocked: { reason: "timed out", run: { kind: "write", step: "technical spec", trigger: "#15 was approved" } } }), facts({ subs: [sub(15, "functional spec", "closed", "completed")] }), "run write technical spec"],
  ["a queued or running issue does nothing", tracked(), facts({ busy: true, subs: [sub(15, "functional spec", "closed", "completed")] }), "none"],
  ["finished issues stay finished", tracked({ finished: "Done" }), facts(), "none"],
  ["triaged but no sub-issue yet does nothing", tracked(), facts(), "none"],
  ["implementation sub-issue open, no pull request yet, does nothing", tracked(), facts({ subs: [sub(12, "fix plan", "closed", "completed"), sub(13, "implementation")] }), "none"],
];

const describe = (d) =>
  d.run ? `run ${d.run.kind}${d.run.kind === "write" ? ` ${d.run.step}` : ""}` : d.finish ? `finish ${d.finish.split(":")[0]}` : `none${d.recheck ? " recheck" : ""}`;

let failed = 0;
for (const [name, t, f, want] of cases) {
  const got = describe(decide(t, f));
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: wanted "${want}", got "${got}"`}`);
}

for (const [title, want] of [["Functional spec: X", "functional spec"], ["fix plan: x", "fix plan"], ["Implementation: X", "implementation"], ["Add webhooks", null]]) {
  const ok = stepOf(title) === want;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} stepOf("${title}")`);
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
