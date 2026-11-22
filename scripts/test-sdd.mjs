#!/usr/bin/env node
// Tests the issue flow's step decision (decide() in sdd.mjs) against fixed GitHub data, with
// no network. Run: node scripts/test-sdd.mjs
import { decide, howToContinue, stepOf, LABEL_BLOCKED, LABEL_QUESTION, LABEL_START } from "../sdd.mjs";

const NOW = Date.parse("2026-11-08T12:00:00Z");
const QUIET = 15 * 60_000;
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const ENABLED = "2026-11-01T00:00:00Z";

const issue = (o = {}) => ({ number: 7, title: "Add webhooks", state: "open", stateReason: null, labels: [], createdAt: "2026-11-05T10:00:00Z", authorCanWrite: true, ...o });
const sub = (number, step, state = "open", stateReason = null) => ({ number, step, title: `${step}: Add webhooks`, state, stateReason });
const comment = (o = {}) => ({ id: 100, on: "#16", author: "owner", createdAt: ago(30), body: "please change X", canWrite: true, byFlow: false, ...o });
const facts = (o = {}) => ({ issue: issue(o.issue), subs: o.subs ?? [], pr: o.pr ?? null, comments: o.comments ?? [], now: NOW, quietMs: QUIET, enabledAt: ENABLED, busy: o.busy ?? false, implementer: o.implementer ?? "agent" });
// An issue with an open pull request, whose technical spec #16 the owner reopened or re-closed.
const withPr = (tech = "open", reason = null, o = {}) => facts({
  subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", tech, reason), sub(17, "implementation")],
  pr: { number: 18, state: "open" }, ...o,
});
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
  ["label removed reruns the blocked step", tracked({ blocked: { reason: "timed out", run: { kind: "write", step: "technical spec", trigger: "#15 was approved" } } }), facts({ subs: [sub(15, "functional spec", "closed", "completed")] }), "run write technical spec unblock"],
  ["a queued or running issue does nothing", tracked(), facts({ busy: true, subs: [sub(15, "functional spec", "closed", "completed")] }), "none"],
  ["finished issues stay finished", tracked({ finished: "Done" }), facts(), "none"],
  ["triaged but no sub-issue yet does nothing", tracked(), facts(), "none"],
  ["implementation sub-issue open, no pull request yet, does nothing", tracked(), facts({ subs: [sub(12, "fix plan", "closed", "completed"), sub(13, "implementation")] }), "none"],
  // Going back a step
  ["reopened technical spec goes back and waits for comments", tracked({ pr: 18 }), withPr(), "none back"],
  ["comments on the reopened spec revise it, not the pull request", tracked({ pr: 18 }), withPr("open", null, { comments: [comment({ on: "#16" })] }), "run revise back"],
  ["comments still coming on the reopened spec wait", tracked({ pr: 18 }), withPr("open", null, { comments: [comment({ on: "#16", createdAt: ago(2) })] }), "none recheck back"],
  ["re-approved technical spec reworks the pull request", tracked({ pr: 18, back: { sub: 16, step: "technical spec" } }), withPr("closed", "completed"), "run rework"],
  ["re-approved technical spec without a pull request implements", tracked({ back: { sub: 16, step: "technical spec" } }), facts({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", "closed", "completed"), sub(17, "implementation")] }), "run implement"],
  ["rejected while back stops the flow", tracked({ pr: 18, back: { sub: 16, step: "technical spec" } }), withPr("closed", "not_planned"), "finish Stopped"],
  ["re-approved functional spec revises the technical spec first", tracked({ pr: 18, back: { sub: 15, step: "functional spec" } }), withPr("closed", "completed"), "run revise reopen"],
  ["reopened functional spec goes back", tracked({ pr: 18 }), facts({ subs: [sub(15, "functional spec"), sub(16, "technical spec", "closed", "completed")], pr: { number: 18, state: "open" } }), "none back"],
  ["reopened and closed again between two checks reworks", tracked({ pr: 18, approvedAt: { 16: "2026-11-08T10:00:00Z" } }), withPr("closed", "completed", { subs: [sub(15, "functional spec", "closed", "completed"), { ...sub(16, "technical spec", "closed", "completed"), closedAt: "2026-11-08T11:30:00Z" }, sub(17, "implementation")] }), "run rework"],
  ["an approval the watcher already recorded does nothing", tracked({ pr: 18, approvedAt: { 16: "2026-11-08T11:30:00Z" } }), withPr("closed", "completed", { subs: [sub(15, "functional spec", "closed", "completed"), { ...sub(16, "technical spec", "closed", "completed"), closedAt: "2026-11-08T11:30:00Z" }, sub(17, "implementation")] }), "none"],
  // Copilot
  ["comments mentioning @copilot never trigger the container's agent", tracked({ pr: 18 }), withPr("closed", "completed", { comments: [comment({ on: "pull request", body: "@copilot rename this", forCopilot: true })] }), "none"],
  ["with Copilot implementing, pull request feedback is left to Copilot", tracked({ pr: 18 }), withPr("closed", "completed", { implementer: "copilot", comments: [comment({ on: "pull request" })] }), "none"],
  ["with Copilot, an approved spec still hands over the implementation", tracked(), facts({ implementer: "copilot", subs: [sub(16, "technical spec", "closed", "completed")] }), "run implement"],
  ["with Copilot assigned and no pull request yet, waits", tracked({ copilotAssignedAt: ago(10) }), facts({ implementer: "copilot", subs: [sub(16, "technical spec", "closed", "completed")] }), "none"],
  // Blocked issues (#22): questions are answered by commenting, failures retried by commenting,
  // run limits only continue when the label is removed.
  ["answer on the issue, quiet for long enough, reruns the step", tracked(), blockedQ({ comments: [comment({ on: "issue" })] }), "run revise unblock"],
  ["answer still being written waits, and rechecks", tracked(), blockedQ({ comments: [comment({ on: "issue", createdAt: ago(5) })] }), "none recheck"],
  ["answer on the sub-issue reruns the step", tracked(), blockedQ({ comments: [comment({ on: "#16" })] }), "run revise unblock"],
  ["no answer yet waits for it", tracked(), blockedQ(), "none"],
  ["the agent's own comment doesn't answer", tracked(), blockedQ({ comments: [comment({ byFlow: true })] }), "none"],
  ["a comment without write access doesn't answer", tracked(), blockedQ({ comments: [comment({ canWrite: false })] }), "none"],
  ["an @copilot comment doesn't answer", tracked(), blockedQ({ comments: [comment({ forCopilot: true })] }), "none"],
  ["a comment from before the question doesn't answer", tracked(), blockedQ({ comments: [comment({ createdAt: ago(90) })] }), "none"],
  ["several comments, the newest still fresh, wait", tracked(), blockedQ({ comments: [comment({ createdAt: ago(40) }), comment({ id: 101, createdAt: ago(3) })] }), "none recheck"],
  ["the question label removed by hand reruns", tracked(), blockedQ({ labels: [] }), "run revise unblock"],
  ["the spec the question is about approved: next step", tracked(), blockedQ({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", "closed", "completed")] }), "run implement unblock"],
  ["the spec the question is about rejected: stops", tracked(), blockedQ({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", "closed", "not_planned")] }), "finish Stopped"],
  ["answer on a reopened spec while going back reruns that revise", tracked({ pr: 18, back: { sub: 16, step: "technical spec" } }),
    blockedQ({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec"), sub(17, "implementation")], pr: { number: 18, state: "open" }, comments: [comment({ on: "#16" })] }), "run revise unblock"],
  ["a question about a spec it was to reopen isn't answered by that spec being closed", tracked({ pr: 18 }),
    blocked({ kind: "question", label: LABEL_QUESTION, run: { kind: "revise", step: "technical spec", sub: 16, reopen: true, trigger: "#15 was approved again" } },
      { subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec", "closed", "completed"), sub(17, "implementation")], pr: { number: 18, state: "open" } }), "none"],
  ["a failed run is retried by a comment", tracked(), blocked({ kind: "failed", label: LABEL_BLOCKED, reason: "timed out after 60 min" }, { comments: [comment({ on: "issue" })] }), "run revise unblock"],
  ["a failed run waits without a comment", tracked(), blocked({ kind: "failed", label: LABEL_BLOCKED, reason: "timed out after 60 min" }), "none"],
  ["a run-limit block isn't lifted by a comment", tracked(), blocked({ kind: "limit", label: LABEL_BLOCKED, reason: "10 runs on this issue reached SDD_MAX_RUNS_PER_ISSUE" }, { comments: [comment({ on: "issue" })] }), "none"],
  ["a run-limit block is lifted by removing the label", tracked(), blocked({ kind: "limit", label: LABEL_BLOCKED, reason: "10 runs on this issue reached SDD_MAX_RUNS_PER_ISSUE" }, { labels: [] }), "run revise unblock"],
  ["an old question block (no kind, sdd: blocked) is answered by a comment", tracked(), blocked({ reason: "the agent has a question: which one?" }, { comments: [comment({ on: "issue" })] }), "run revise unblock"],
  ["an old question block continues when sdd: blocked is removed", tracked(), blocked({ reason: "the agent has a question: which one?" }, { labels: [] }), "run revise unblock"],
  ["an old run-limit block isn't lifted by a comment", tracked(), blocked({ reason: "10 runs on this issue reached SDD_MAX_RUNS_PER_ISSUE; remove the label to allow 10 more" }, { comments: [comment({ on: "issue" })] }), "none"],
  ["the question label put on by hand pauses", tracked(), facts({ issue: { labels: [LABEL_QUESTION] }, subs: [sub(15, "functional spec", "closed", "completed")] }), "none"],
];

// A tracked issue blocked at ago(60) with the given block, its label on unless facts say otherwise.
function blocked(b, o = {}) {
  const block = { reason: "something", run: { kind: "revise", step: "technical spec", sub: 16, trigger: "1 new comment(s) on #16" }, at: ago(60), ...b };
  const f = facts({ subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec")], ...o, issue: { labels: o.labels ?? [block.label ?? LABEL_BLOCKED] } });
  f.block = block;
  return f;
}
function blockedQ(o) {
  return blocked({ kind: "question", label: LABEL_QUESTION, reason: "the agent has a question: which provider?" }, o);
}
for (const c of cases) if (c[2].block) { c[1] = { ...c[1], blocked: c[2].block }; delete c[2].block; }

const describe = (d) =>
  (d.run ? `run ${d.run.kind}${d.run.kind === "write" ? ` ${d.run.step}` : ""}${d.run.reopen ? " reopen" : ""}` : d.finish ? `finish ${d.finish.split(":")[0]}` : `none${d.recheck ? " recheck" : ""}`) +
  (d.back ? " back" : "") + (d.unblock && !d.finish ? " unblock" : "");

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

// What the status comment says, and what the owner can do, per state.
const run16 = { kind: "revise", step: "technical spec", sub: 16 };
const specOpen = { subs: [sub(15, "functional spec", "closed", "completed"), sub(16, "technical spec")] };
for (const [name, t, f, head, footer] of [
  ["question", { blocked: { kind: "question", reason: "the agent has a question: which provider?", run: run16 } }, specOpen, "Waiting for your answer: which provider?", "Reply on this issue or on #16 to continue."],
  ["question from triage", { blocked: { kind: "question", reason: "the agent has a question: is this a bug?", run: { kind: "triage" } } }, { subs: [] }, "Waiting for your answer: is this a bug?", "Reply on this issue to continue."],
  ["failed", { blocked: { kind: "failed", reason: "the run timed out after 60 min", run: run16 } }, specOpen, "Blocked: the run timed out after 60 min", "Comment to retry (you can add advice for the agent), or remove the `sdd: blocked` label."],
  ["limit", { blocked: { kind: "limit", reason: "the daily cap of 30 runs (SDD_MAX_RUNS_PER_DAY) was reached", run: run16 } }, specOpen, "Blocked: the daily cap of 30 runs (SDD_MAX_RUNS_PER_DAY) was reached", "Remove the `sdd: blocked` label to continue."],
  ["spec in review", { status: "Technical spec #16 ready for review" }, specOpen, "Technical spec #16 ready for review", "Comment to ask for changes; close #16 as completed to approve it."],
  ["pull request open", { status: "Pull request #18 ready for review" }, { subs: [sub(17, "implementation")], pr: { number: 18, state: "open" } }, "Pull request #18 ready for review", "Comment on pull request #18 for changes; merge it when you're happy."],
  ["running", { status: "Implementing, started", running: { kind: "implement" } }, specOpen, "Implementing, started", "The agent is working on it; nothing to do right now."],
  ["finished", { finished: "Done" }, specOpen, "Done", null],
]) {
  const got = howToContinue(t, f);
  const ok = got.head === head && got.footer === footer;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} howToContinue: ${name}${ok ? "" : `: got ${JSON.stringify(got)}`}`);
}

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
