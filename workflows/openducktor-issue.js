// Copy this file into a target repo's .claude/workflows/ directory
// (plugins cannot distribute Workflow scripts today; only agents/
// are plugin-discoverable). Requires scripts/odt-transition.sh to
// also be copied into that repo's scripts/ directory, and the four
// agents from this plugin to be installed.
//
// Run with: Workflow({ scriptPath: ".claude/workflows/openducktor-issue.js", args: { issueNumber: 142 } })
// or as a slash command: /openducktor-issue 142 (args arrives as the bare string "142")

export const meta = {
  name: "openducktor-issue",
  description: "Drive one GitHub issue through spec -> plan -> build -> qa",
  phases: [{ title: "Spec" }, { title: "Plan" }, { title: "Build" }, { title: "QA" }],
};

const issue = typeof args === "object" && args !== null ? args.issueNumber : args;
if (!issue) {
  throw new Error(
    'Missing issue number. Pass args: { issueNumber: N } or invoke as "/openducktor-issue N".',
  );
}
const label = await agent(
  `Run: gh issue view ${issue} --json labels --jq '.labels[].name | select(startswith("status:"))'. Return only that label string.`,
  { label: "read-label" },
);

async function transition(to) {
  await agent(`Run: bash scripts/odt-transition.sh ${issue} ${to}`, { label: "transition" });
}

if (label === "status:open") {
  phase("Spec");
  await agent(`Read GitHub issue ${issue} and write its specification.`, {
    agentType: "openducktor-agents:spec-agent",
    phase: "Spec",
  });
  await transition("status:spec-ready");
}

if (label === "status:open" || label === "status:spec-ready") {
  phase("Plan");
  await agent(`Read GitHub issue ${issue}'s spec and write its implementation plan.`, {
    agentType: "openducktor-agents:planner-agent",
    phase: "Plan",
  });
  await transition("status:ready-for-dev");
}

phase("Build");
await agent(`Implement GitHub issue ${issue} per its spec and plan.`, {
  agentType: "openducktor-agents:build-agent",
  phase: "Build",
});
await transition("status:ai-review");

phase("QA");
const qaReport = await agent(
  `Review the pull request for GitHub issue ${issue} against its spec and plan.`,
  { agentType: "openducktor-agents:qa-agent", phase: "QA" },
);

if (qaReport.includes("QA-VERDICT: approved")) {
  await transition("status:human-review");
  log(`Issue ${issue} ready for human review.`);
} else {
  await transition("status:in-progress");
  log(`Issue ${issue} sent back to build after QA rejection.`);
}
