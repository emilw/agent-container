#!/usr/bin/env node
// A stand-in agent for testing the issue flow's plumbing without an agent tool or tokens. It
// reads the brief on stdin, does the step mechanically with gh and git, and writes the result
// file. Use it in a test container only, in a sandbox repository:
//   SDD_AGENT_COMMAND="node /path/to/fake-sdd-agent.mjs"
// FAKE_OUTCOME=question|failed|crash|nothing|slow makes it misbehave on purpose, and
// FAKE_PATH=small makes triage take the small-bug path.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const brief = readFileSync(0, "utf8");
const meta = JSON.parse(brief.match(/<!-- sdd:brief (.*?) -->/)[1]);
const MARK = "<!-- sdd:agent -->";
const gh = (...args) => execFileSync("gh", args, { cwd: meta.cwd, encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { cwd: meta.cwd, encoding: "utf8" }).trim();
const result = (outcome, summary) => writeFileSync(meta.resultFile, JSON.stringify({ outcome, summary }));
const Step = (s) => s[0].toUpperCase() + s.slice(1);
console.log(`fake agent: ${meta.kind} ${meta.step} for #${meta.issue}`);

const outcome = process.env.FAKE_OUTCOME;
if (outcome === "crash") process.exit(3);
if (outcome === "slow") await new Promise((r) => setTimeout(r, 10 * 60_000));
if (outcome === "nothing") { result("done", "Claims done, did nothing."); process.exit(0); }
if (outcome === "failed") { result("failed", "Couldn't do it on purpose."); process.exit(0); }
if (outcome === "question") {
  gh("issue", "comment", String(meta.issue), "--body", `${MARK}\nShould the fake agent use A or B?`);
  result("question", "Should it use A or B?");
  process.exit(0);
}

const title = JSON.parse(gh("issue", "view", String(meta.issue), "--json", "title")).title;
function createSub(step, body) {
  const url = gh("issue", "create", "--title", `${Step(step)}: ${title}`, "--body", `Part of #${meta.issue}.\n\n${body}`);
  const number = url.split("/").pop();
  const id = gh("api", `repos/${meta.repo}/issues/${number}`, "--jq", ".id");
  gh("api", `repos/${meta.repo}/issues/${meta.issue}/sub_issues`, "-X", "POST", "-F", `sub_issue_id=${id}`);
  return number;
}

switch (meta.kind) {
  case "triage": {
    const step = process.env.FAKE_PATH === "small" ? "fix plan" : "functional spec";
    gh("issue", "comment", String(meta.issue), "--body", `${MARK}\nTriage: ${step === "fix plan" ? "small bug" : "full path"}.`);
    result("done", `Wrote the ${step} as #${createSub(step, "Fake spec.")}.`);
    break;
  }
  case "write":
    result("done", `Wrote the ${meta.step} as #${createSub(meta.step, "Fake spec.")}.`);
    break;
  case "revise": {
    const body = JSON.parse(gh("issue", "view", String(meta.sub), "--json", "body")).body;
    gh("issue", "edit", String(meta.sub), "--body", `${body}\n\nRevised at ${new Date().toISOString()}.`);
    gh("issue", "comment", String(meta.sub), "--body", `${MARK}\nRevised.`);
    result("done", `Revised #${meta.sub}.`);
    break;
  }
  case "implement": {
    const subs = JSON.parse(gh("api", `repos/${meta.repo}/issues/${meta.issue}/sub_issues`));
    const impl = subs.find((s) => s.state === "open" && /^implementation:/i.test(s.title))?.number ?? createSub("implementation", "- [x] Code\n- [x] Tested\n- [x] Docs updated\n- [ ] Pull request:");
    appendFileSync(`${meta.cwd}/fake-${meta.issue}.txt`, `change for #${meta.issue}\n`);
    git("add", "-A");
    git("-c", "user.name=fake agent", "-c", "user.email=fake@example.test", "commit", "-q", "-m", `Fake change for #${meta.issue}`);
    git("push", "-q", "-u", "origin", meta.branch);
    const pr = gh("pr", "create", "--head", meta.branch, "--title", title, "--body", `${MARK}\nCloses #${meta.issue}\nCloses #${impl}`);
    result("done", `Opened ${pr}.`);
    break;
  }
  case "revise-pr":
    appendFileSync(`${meta.cwd}/fake-${meta.issue}.txt`, "revised\n");
    git("add", "-A");
    git("-c", "user.name=fake agent", "-c", "user.email=fake@example.test", "commit", "-q", "-m", "Address feedback");
    git("push", "-q");
    gh("pr", "comment", String(meta.pr), "--body", `${MARK}\nUpdated.`);
    result("done", `Updated #${meta.pr}.`);
    break;
}
