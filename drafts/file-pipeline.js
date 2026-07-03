// DRAFT / INACTIVE. This file lives under drafts/ and is not part of the
// plugin's discovered workflows/ directory; nothing invokes it. The
// in-session file-pipeline skill was chosen as the variant to keep, and
// this dynamic-workflow variant was deactivated (not deleted). See
// drafts/README.md for the reactivation steps.
//
// The file-based issue pipeline as a dynamic Workflow.
//
// This is the workflow twin of skills/file-pipeline/SKILL.md. It drives
// one GitHub issue through spec -> plan -> build -> QA with all state and
// all four artifacts on the local filesystem under <repo>.issues/<issue>/,
// exactly as the skill does, and it spawns the same four file-writing
// agents for the heavy per-phase work. The GitHub issue is only the
// input; a pull request is only the ship channel; nothing is posted to
// the issue thread.
//
// Why a workflow when the interactive file-pipeline skill already
// exists: that skill runs the whole loop in the session's own context so
// it can call AskUserQuestion and continue in the SAME run. A workflow's
// agent() calls are subagents and cannot prompt, and the workflow
// runtime has no prompt primitive of its own. So this workflow cannot
// ask a question mid-run. Instead, whenever a human decision is needed
// (an agent raised a clarification, or a manual gate needs
// approve/revise, or a dependency is missing) it persists the question
// to state.json.pendingQuestion and RETURNS a small typed object
// describing what it is waiting on. It never guesses.
//
// A thin session-context shell (skills/file-pipeline-workflow/SKILL.md)
// is what makes that feel continuous to a human: the shell launches this
// workflow, reads the returned "waiting" object, calls AskUserQuestion
// itself (it can, being in the session), and relaunches this workflow
// with the answer as an arg. Relaunch uses resumeFromRunId, so every
// phase already completed replays from cache instantly and only the
// answer-consuming call onward runs live. From the human's seat it is
// one continuous ask/answer/continue; under the hood it is
// stop-and-resume across the answer.
//
// This engine and its shell are a third entry point alongside the two
// pre-existing ones: the interactive file-pipeline skill (same local
// storage, but drives the loop itself in-session) and the gh-posting
// gh-pipeline workflow (state in GitHub labels, artifacts on threads).
//
// The workflow is equally drivable headless with no shell at all: pass
// answers as args directly (see parseArgs). auto mode raises no question
// by construction, so it runs straight through with no shell and no
// relaunch.
//
// Run with (normally via the shell, but directly too):
//   Workflow({ scriptPath: ".claude/workflows/file-pipeline.js",
//              args: { issueNumber: 142, mode: "semi-auto" } })
//   Workflow({ scriptPath: "...", args: { issueNumber: 142, answer: "..." } })
//   Workflow({ scriptPath: "...", args: { issueNumber: 142, directive: { kind: "approve" } } })
//   Workflow({ scriptPath: "...", args: { issueNumber: 142, mode: "merge" } })
//
// Requires .claude/scripts/issue-state-transition.sh copied into the
// target repo, and the four file-writing agents from this plugin
// installed (dev-crew:spec-writer, planner,
// builder, reviewer).

export const meta = {
  name: "file-pipeline",
  description:
    "Drive one GitHub issue through spec -> plan -> build -> qa with state and artifacts on the local filesystem; stop-and-return on any human decision",
  phases: [{ title: "Spec" }, { title: "Plan" }, { title: "Build" }, { title: "QA" }],
};

// In auto/semi-auto, a QA rejection loops straight back to build, up to
// this many build -> QA rounds, before leaving the issue at in-progress
// for a human. Matches the skill and the gh-posting workflow.
const MAX_QA_ROUNDS = 3;

const TRANSITION = ".claude/scripts/issue-state-transition.sh";

// Phase definitions. entryStatus is the state.json.status this phase runs
// from; agentType is the file-writing agent; the artifact filename is
// fixed. Build has a two-step transition (into in-progress, then out to
// ai-review) that the phase loop handles specially.
const PHASE_DEFS = [
  {
    key: "spec",
    label: "Spec",
    artifact: "spec.md",
    entryStatus: ["open"],
    toStatus: "spec-ready",
    gateStatus: "spec-awaiting-approval",
    agentType: "dev-crew:spec-writer",
  },
  {
    key: "plan",
    label: "Plan",
    artifact: "plan.md",
    entryStatus: ["spec-ready"],
    toStatus: "ready-for-dev",
    gateStatus: "plan-awaiting-approval",
    agentType: "dev-crew:planner",
  },
  {
    key: "build",
    label: "Build",
    artifact: "build.md",
    entryStatus: ["ready-for-dev", "in-progress", "blocked"],
    // Build's entry is its own transition (ready-for-dev/blocked ->
    // in-progress), skipped when already at in-progress. toStatus is
    // applied after the agent completes.
    startStatus: "in-progress",
    toStatus: "ai-review",
    gateStatus: "build-awaiting-approval",
    agentType: "dev-crew:builder",
  },
  {
    key: "qa",
    label: "QA",
    artifact: "qa.md",
    entryStatus: ["ai-review"],
    // No single toStatus: the verdict picks human-review vs in-progress.
    gateStatus: "qa-awaiting-approval",
    agentType: "dev-crew:reviewer",
  },
];

// The structured return the four file-writing agents already produce
// (see agents/*-writer-agent.md, *-runner-agent.md, *-review-agent.md).
const AGENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["done", "clarification-needed"] },
    question: { type: "string" },
    options: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "description"],
        properties: { label: { type: "string" }, description: { type: "string" } },
      },
    },
    recommendedDefault: { type: "string" },
  },
};

// ---- bookkeeping helpers (all on Haiku, structured where a chatty or
// empty plain-text result could otherwise be mistaken for real content
// and stall the loop, exactly as the gh-posting workflow does) ----

// Cache-busting nonce for reads of MUTABLE on-disk state. Two things vary
// it, and both matter:
//
//  - LAUNCH: parsed.launch, the counter the shell bumps on every relaunch.
//    A resume via resumeFromRunId replays every agent() call with a
//    byte-identical (prompt, opts), which is right for the expensive phase
//    agents but wrong for a re-read of state.json that changed on disk
//    since the cached run. Varying the read prompt per launch makes those
//    reads run live and see the current file.
//  - BUMP: a within-run counter incremented on every state-mutating write
//    (patchState, transitionTo, seedState). Without it, two readState
//    calls in the SAME run after two different writes would share a cache
//    key and the second would replay the first's (now stale) result. The
//    report called this out as a within-run trap; bumping on each write
//    closes it.
//
// Only reads of state this workflow (or its agents) mutates get busted:
// state.json, artifact presence, the QA verdict, the linked PR, dependency
// artifacts. resolvePaths is deliberately NOT busted: the repo location
// never changes across relaunches, so caching it is correct and cheaper.
let LAUNCH = 1;
let BUMP = 0;
const bumpState = () => {
  BUMP += 1;
};
const cacheBust = (prompt) =>
  `${prompt} (Reads current on-disk state; launch ${LAUNCH}, revision ${BUMP}. This trailing note does not change what to run.)`;

// A local issue's id starts with "L" (e.g. L3). It has no GitHub issue:
// its description lives in <dir>/issue.md, the pipeline reads that file
// instead of `gh issue view`, and the build phase opens a PR that
// references the id in text rather than closing a GitHub issue with
// "Closes #N". A numeric id is a real GitHub issue and behaves as before.
const isLocalId = (id) => /^L\d+$/.test(String(id));

// The phrase handed to a phase agent for where to read the issue from,
// and how to refer to it. For a GitHub issue: read it with gh. For a
// local issue: read the local issue.md; there is no gh issue to view.
function issueSourceInstruction(issue, dir) {
  return isLocalId(issue)
    ? `local issue ${issue} (read its description from the file ${dir}/issue.md; it has no GitHub issue)`
    : `GitHub issue ${issue}`;
}

// The issues state root (a sibling of the checkout named <repo>.issues)
// and the per-issue folder, derived from git so all worktrees of one
// repo share one root. Returns absolute paths.
async function resolvePaths(issue) {
  const out = await agent(
    `Run: git rev-parse --git-common-dir. That prints a path ending in "/.git" (or ".git"); resolve it to ` +
      `an absolute path, take its parent directory as the repo root, and set repoName to that directory's ` +
      `basename and parentDir to that directory's parent (both absolute).`,
    {
      label: "resolve-paths",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["parentDir", "repoName"],
        properties: {
          parentDir: { type: "string", description: "Absolute path to the directory containing the repo root." },
          repoName: { type: "string", description: "Basename of the repo root directory." },
        },
      },
    },
  );
  const root = `${out.parentDir}/${out.repoName}.issues`;
  return { root, dir: `${root}/${issue}` };
}

// Read the whole state.json as an object. Returns null if the file does
// not exist yet.
async function readState(dir) {
  const out = await agent(
    cacheBust(
      `Run: cat ${dir}/state.json 2>/dev/null. If the file does not exist or stdout is empty, set exists to ` +
        `false and leave state null. Otherwise set exists true and state to the parsed JSON object.`,
    ),
    {
      label: "read-state",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["exists"],
        properties: {
          exists: { type: "boolean" },
          state: { type: ["object", "null"], additionalProperties: true },
        },
      },
    },
  );
  return out?.exists ? (out.state ?? null) : null;
}

// Bootstrap the folder and a fresh state.json if absent. Returns the
// current state object either way.
async function ensureState(dir, mode) {
  const existing = await readState(dir);
  if (existing) {
    return existing;
  }
  const seed = {
    status: "open",
    mode,
    prNumber: null,
    qaVerdict: null,
    pendingQuestion: null,
    dependsOn: [],
  };
  const out = await agent(
    `Run these commands exactly, under bash. Do not substitute or invent any other command; if any exits ` +
      `non-zero, STOP, set ok=false, and put stderr in error. Never attempt a recovery command.\n\n` +
      `mkdir -p ${dir} && cat > ${dir}/state.json <<'JSON'\n${JSON.stringify(seed, null, 2)}\nJSON\n\n` +
      `Set ok=true only if both the mkdir and the file write succeeded.`,
    {
      label: "seed-state",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
      },
    },
  );
  if (!out?.ok) {
    throw new Error(`seed-state failed for ${dir}/state.json: ${out?.error ?? "unknown error"}`);
  }
  bumpState();
  return seed;
}

// Write one or more non-status fields into state.json, preserving every
// other field. NEVER writes status: only the transition script moves the
// machine.
//
// This is deliberately robust against the two ways an earlier version
// corrupted state.json: (1) it never inlines the patch JSON into the jq
// command string (which broke on shell-quoting of large/parenthesized
// values); the patch is written to a temp file and merged via
// --slurpfile with an additive `. + $patch[0]` so unpatched keys always
// survive. (2) it verifies the write: the bookkeeping agent returns a
// structured {ok,error} and is told never to invent a recovery command,
// and the workflow then re-reads and checks the required keys still
// exist, throwing loudly if the file was damaged. A silent, destructive
// patch can no longer pass unnoticed.
async function patchState(dir, fields) {
  if ("status" in fields) {
    throw new Error("patchState must never write status; use transitionTo (the validated script) instead.");
  }
  const patchJson = JSON.stringify(fields);
  const out = await agent(
    `Run these commands exactly, in order, under bash. Do not substitute, reformat, or invent any other ` +
      `command; if any command exits non-zero, STOP immediately, set ok=false, and put the failing command's ` +
      `stderr in error. Never try an alternative approach or a recovery command.\n\n` +
      `1. Write the patch to a temp file with a heredoc (the quoted 'JSON' delimiter means no expansion):\n` +
      `cat > ${dir}/.state.patch.json <<'JSON'\n${patchJson}\nJSON\n\n` +
      `2. Merge it additively over the existing state (unpatched keys are preserved) into a temp file, then ` +
      `atomically move it into place:\n` +
      `jq --slurpfile patch ${dir}/.state.patch.json '. + $patch[0]' ${dir}/state.json > ${dir}/.state.tmp ` +
      `&& mv ${dir}/.state.tmp ${dir}/state.json && rm -f ${dir}/.state.patch.json\n\n` +
      `Set ok=true only if every command above exited 0.`,
    {
      label: "patch-state",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
      },
    },
  );
  if (!out?.ok) {
    throw new Error(`patchState(${Object.keys(fields).join(", ")}) failed: ${out?.error ?? "unknown error"}`);
  }
  // The file changed on disk; bump so the verify read (and any later read
  // this run) gets a fresh cache key and sees the new content.
  bumpState();
  // Verify the invariant the patch must not have broken: the required
  // structural keys still exist. A damaged file (e.g. reduced to only the
  // patched key) is caught here rather than surfacing later as an
  // "Unknown mode undefined" or a lost status.
  const after = await readState(dir);
  if (!after || typeof after.status !== "string" || typeof after.mode !== "string") {
    throw new Error(
      `patchState(${Object.keys(fields).join(", ")}) left state.json missing required keys (status/mode); ` +
        `refusing to continue with a corrupt state file at ${dir}/state.json.`,
    );
  }
  return after;
}

// Move the state machine through the single validated mutator. A
// non-zero exit (illegal transition, missing file) is a hard failure:
// surface it, never force it through with a different target.
async function transitionTo(root, issue, to) {
  const out = await agent(
    `Run: bash ${TRANSITION} ${root} ${issue} ${to}. Set ok to true only if the command exited 0; ` +
      `otherwise set ok false and put the stderr text in error.`,
    {
      label: "transition",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok"],
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
      },
    },
  );
  if (!out?.ok) {
    throw new Error(`Transition ${issue} -> ${to} failed: ${out?.error ?? "unknown error"}`);
  }
  // status changed on disk; bump so a later readState this run sees it.
  bumpState();
}

// The pull request for this issue, or null. Re-derived fresh every call,
// never trusted from a cache.
//
// For a GitHub issue, the PR is the one GitHub considers linked via
// "Closes #N" (closedByPullRequestsReferences). A local issue has no
// GitHub issue and its PR carries no "Closes" link, so instead find the
// open PR whose head is the current branch (the branch the build agent
// worked on and opened the PR from).
async function findLinkedPr(issue) {
  const prompt = isLocalId(issue)
    ? `Run: gh pr list --head "$(git rev-parse --abbrev-ref HEAD)" --state all --json number --jq '.[0].number'. ` +
      `Set prNumber to that number, or null if the output is empty.`
    : `Run: gh repo view --json owner,name --jq '.owner.login + " " + .name'. Then run exactly: ` +
      `gh api graphql -f query='query { repository(owner: "OWNER", name: "NAME") { issue(number: ${issue}) { ` +
      `closedByPullRequestsReferences(first: 5) { nodes { number } } } } }' with OWNER and NAME substituted ` +
      `from the first command. Set prNumber to the first node's number, or null if there are none.`;
  const out = await agent(cacheBust(prompt), {
    label: "find-linked-pr",
    model: "haiku",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["prNumber"],
      properties: { prNumber: { type: ["integer", "null"] } },
    },
  });
  return typeof out?.prNumber === "number" ? out.prNumber : null;
}

// Batched QA read: verify qa.md exists and read its verdict in ONE spawn
// (both only read qa.md), instead of a check-artifact spawn plus a
// read-qa-verdict spawn. Returns { present, verdict }.
async function verifyQaAndReadVerdict(dir) {
  const out = await agent(
    cacheBust(
      `Run under bash: if [ ! -s ${dir}/qa.md ]; then echo MISSING; else grep -o 'QA-VERDICT: [a-z]*' ${dir}/qa.md | tail -1; fi. ` +
        `If stdout is "MISSING", set present=false. Otherwise set present=true and verdict="approved" if the ` +
        `printed line ends in approved, else "rejected".`,
    ),
    {
      label: "verify-qa-verdict",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["present"],
        properties: {
          present: { type: "boolean" },
          verdict: { type: "string", enum: ["approved", "rejected"] },
        },
      },
    },
  );
  return { present: Boolean(out?.present), verdict: out?.verdict === "approved" ? "approved" : "rejected" };
}

// Read the last QA-VERDICT: line out of qa.md itself (never trust the
// agent's summary of its own verdict). Returns "approved" | "rejected".
async function readQaVerdict(dir) {
  const out = await agent(
    cacheBust(
      `Run: grep -o 'QA-VERDICT: [a-z]*' ${dir}/qa.md | tail -1. Set verdict to "approved" if that line ends ` +
        `in approved, otherwise "rejected".`,
    ),
    {
      label: "read-qa-verdict",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["verdict"],
        properties: { verdict: { type: "string", enum: ["approved", "rejected"] } },
      },
    },
  );
  return out?.verdict === "approved" ? "approved" : "rejected";
}

// Batched post-phase bookkeeping: verify the artifact exists, run the ONE
// validated transition, and read the new state back, all in a SINGLE agent
// spawn instead of three. Each subagent spawn pays a large fixed context
// cost (~19k tokens) regardless of the trivial shell work it does, so
// collapsing check-artifact + transition + read-state from three spawns to
// one is the biggest available saving on bookkeeping overhead.
//
// It preserves every guarantee the three separate calls gave:
//  - the artifact-existence check (test -s) still gates advancement;
//  - the status move still goes ONLY through issue-state-transition.sh, and
//    its exit code is still checked (a non-zero exit -> ok:false -> the
//    caller throws), so an illegal transition still fails loudly and the
//    validated table remains the single mutator;
//  - the returned state is a fresh read of the file after the transition.
// The commands are &&-chained so a failed artifact check or a failed
// transition never proceeds to the read; the agent reports which step
// failed. Cache-busted like every other mutable-state read.
async function verifyAndAdvance(dir, root, issue, artifact, toStatus) {
  const out = await agent(
    cacheBust(
      `Run these commands in order under bash and report the result. Do not invent or substitute any command.\n\n` +
        `1. test -s ${dir}/${artifact} || { echo "MISSING_ARTIFACT" >&2; exit 3; }\n` +
        `2. bash ${TRANSITION} ${root} ${issue} ${toStatus}\n` +
        `3. cat ${dir}/state.json\n\n` +
        `Set artifactPresent=false and ok=false with error="artifact missing" if step 1 failed (exit 3). ` +
        `Set ok=false and put the transition's stderr in error if step 2 exited non-zero. Only if steps 1 and 2 ` +
        `both succeeded, set ok=true, artifactPresent=true, and state to the JSON object step 3 printed.`,
    ),
    {
      label: "verify-advance",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["ok", "artifactPresent"],
        properties: {
          ok: { type: "boolean" },
          artifactPresent: { type: "boolean" },
          error: { type: "string" },
          state: { type: ["object", "null"], additionalProperties: true },
        },
      },
    },
  );
  if (!out?.artifactPresent) {
    throw new Error(`Phase artifact ${dir}/${artifact} is missing or empty after the agent returned done.`);
  }
  if (!out?.ok) {
    throw new Error(`Transition ${issue} -> ${toStatus} failed: ${out?.error ?? "unknown error"}`);
  }
  bumpState();
  const state = out.state ?? null;
  if (!state || typeof state.status !== "string" || typeof state.mode !== "string") {
    throw new Error(`state.json read back after advancing to ${toStatus} is missing required keys (status/mode).`);
  }
  return state;
}

// Resolve the read-only dependency artifact paths for this issue. Returns
// { paths: [...], missing: [issueNumbers] }. paths are spec.md/plan.md of
// each depended-on issue that exists; missing lists depended-on issues
// whose folder/artifacts are not there yet.
async function resolveDependencyPaths(root, dependsOn) {
  if (!Array.isArray(dependsOn) || dependsOn.length === 0) {
    return { paths: [], missing: [] };
  }
  const out = await agent(
    cacheBust(
      `For each issue number in ${JSON.stringify(dependsOn)}, check whether ${root}/<n>/spec.md and ` +
        `${root}/<n>/plan.md exist. Collect the absolute paths that exist into paths, and the issue numbers ` +
        `for which neither exists into missing.`,
    ),
    {
      label: "resolve-deps",
      model: "haiku",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["paths", "missing"],
        properties: {
          paths: { type: "array", items: { type: "string" } },
          missing: { type: "array", items: { type: "integer" } },
        },
      },
    },
  );
  return { paths: out?.paths ?? [], missing: out?.missing ?? [] };
}

// ---- phase agent invocation ----

// Build the read-only context line handed to a phase agent: this issue's
// upstream artifacts plus any dependency artifacts.
function readOnlyPaths(dir, def, depPaths) {
  const upstream = { plan: ["spec.md"], build: ["spec.md", "plan.md"], qa: ["spec.md", "plan.md"] };
  const own = (upstream[def.key] ?? []).map((f) => `${dir}/${f}`);
  return [...own, ...depPaths];
}

// Invoke a phase's file-writing agent. `answer` is a resolved
// clarification to fold in (or null on the first attempt). Returns the
// agent's structured object ({status:"done"} or {status:"clarification-needed",...}).
async function runPhaseAgent(issue, dir, def, { mode, answer, depPaths, prNumber }) {
  const artifactPath = `${dir}/${def.artifact}`;
  const reads = readOnlyPaths(dir, def, depPaths);
  const readsLine = reads.length ? ` Read-only context paths: ${reads.join(", ")}.` : "";
  const autoLine =
    mode === "auto"
      ? ` You are in auto mode: never raise a question. On any ambiguity adopt your own recommended default, ` +
        `record that decision in the artifact, and return {"status":"done"}.`
      : "";
  const answerLine = answer
    ? ` A human answered your open question: "${answer}". Fold it in as a locked decision, do not re-ask it, ` +
      `and write the final artifact.`
    : "";

  const source = issueSourceInstruction(issue, dir);
  const local = isLocalId(issue);
  // A local issue has no GitHub issue to close, so the PR body references
  // the id in text instead of "Closes #N".
  const prBodyInstruction = local
    ? `a clean, repo-facing body that states it implements local issue ${issue} (do NOT add a "Closes #" line; there is no GitHub issue)`
    : `a clean, repo-facing body containing "Closes #${issue}"`;

  let task;
  if (def.key === "spec") {
    task = `Read ${source} and write its specification to the exact path ${artifactPath}.`;
  } else if (def.key === "plan") {
    task = `Read this issue's spec at ${dir}/spec.md and write the implementation plan for ${source} to ${artifactPath}.`;
  } else if (def.key === "build") {
    task =
      `Implement ${source} per its spec (${dir}/spec.md) and plan (${dir}/plan.md). Open or update the ` +
      `pull request with ${prBodyInstruction}. Then write the fuller build ` +
      `summary to ${artifactPath}. Do not post any issue or pull request comment.`;
  } else {
    const prLine = prNumber ? ` The linked pull request is #${prNumber}.` : "";
    task =
      `Review the pull request for ${source} against ${dir}/spec.md and ${dir}/plan.md, and write ` +
      `the QA report to ${artifactPath} ending in exactly one "QA-VERDICT: approved" or "QA-VERDICT: rejected" ` +
      `line.${prLine} Do not post any issue or pull request comment.`;
  }

  return await agent(`${task}${readsLine}${autoLine}${answerLine}`, {
    agentType: def.agentType,
    phase: def.label,
    schema: AGENT_SCHEMA,
  });
}

// Route a QA-rejection (or a QA-gate revise) back to the build agent as
// fixup feedback: QA's reasoning belongs in the code, not re-reviewed.
async function fixupBuild(issue, dir, buildDef, qaReportPath, feedback) {
  const extra = feedback ? ` Additional human feedback: ${feedback}` : "";
  return await agent(
    `Read ${issueSourceInstruction(issue, dir)}. The QA report at ${qaReportPath} rejected the pull request. ` +
      `Address every finding at its root cause against ${dir}/spec.md and ${dir}/plan.md, push to the same pull ` +
      `request branch, rerun relevant verification, and update ${dir}/build.md. Do not post any pull request comment.${extra}`,
    { agentType: buildDef.agentType, phase: "Build", schema: AGENT_SCHEMA },
  );
}

// Revise a spec/plan artifact in place from human feedback. Editorial, so
// it runs on the cheaper model (matching the gh-posting workflow).
async function reviseArtifact(issue, dir, def, feedback) {
  return await agent(
    `For ${issueSourceInstruction(issue, dir)}, a human requested changes to ${dir}/${def.artifact}: "${feedback}". ` +
      `Revise the artifact in place at that path with the changes folded in. Return {"status":"done"}.`,
    { agentType: def.agentType, phase: "Revise", model: "sonnet", schema: AGENT_SCHEMA },
  );
}

// ---- the waiting-return builders: how the workflow hands control back
// to the shell (or a headless caller). Each persists pendingQuestion
// first, then returns a typed object the shell reads to know what to
// AskUserQuestion about. ----

async function stopForQuestion(dir, issue, phaseKey, q) {
  const pending = {
    phase: phaseKey,
    kind: "clarification",
    question: q.question,
    options: q.options,
    recommendedDefault: q.recommendedDefault,
  };
  await patchState(dir, { pendingQuestion: pending });
  log(`Issue ${issue} is waiting on a ${phaseKey} clarification. Answer it and relaunch with args.answer.`);
  return { issue, status: "question", pendingQuestion: pending };
}

async function stopForGate(dir, issue, phaseKey, gateStatus) {
  const pending = {
    phase: phaseKey,
    kind: "gate",
    question: `The ${phaseKey} artifact is written. Approve it, or request a revision?`,
    options: [
      { label: "Approve", description: "Accept the artifact and advance to the next phase." },
      { label: "Revise", description: "Send feedback back into this phase and re-write the artifact." },
    ],
    recommendedDefault: "Approve",
  };
  await patchState(dir, { pendingQuestion: pending });
  log(`Issue ${issue} is at the ${gateStatus} gate. Relaunch with args.directive ({kind:"approve"} or {kind:"revise",feedback:"..."}).`);
  return { issue, status: "gate", gate: gateStatus, pendingQuestion: pending };
}

async function stopForDependency(dir, issue, missing) {
  const pending = {
    phase: "dependency",
    kind: "dependency",
    question: `Depended-on issue(s) ${missing.join(", ")} have no artifacts yet. Proceed without them, or wait?`,
    options: [
      { label: "Proceed", description: "Run this phase without the missing dependency artifacts." },
      { label: "Wait", description: "Stop until the depended-on issue's artifacts exist." },
    ],
    recommendedDefault: "Proceed",
  };
  await patchState(dir, { pendingQuestion: pending });
  log(`Issue ${issue} depends on ${missing.join(", ")} which have no artifacts yet. Relaunch with args.directive.`);
  return { issue, status: "dependency", missing, pendingQuestion: pending };
}

// ---- args ----

// args arrives as one of:
//   { issueNumber, mode?, answer?, directive?, launch? }  (object; the shell/programmatic form)
//   '{"issueNumber":142,...}'                             (that object re-serialized to a string
//                                                           by some resume/relaunch paths)
//   142 | "142" | "142 manual"                            (bare number / slash-command tokens)
// answer, directive, and launch only arrive through the object form; there
// is no slash-command syntax for them (the shell always uses the object form).
//
// launch is a monotonically increasing counter the shell bumps on every
// relaunch (1 on the first launch, 2 on the first resume, and so on). It
// exists only to bust the Workflow agent() result cache for reads of
// mutable on-disk state (see LAUNCH/BUMP / cacheBust): a resume via
// resumeFromRunId replays every agent() call whose (prompt, opts) is
// byte-identical, which is exactly what we want for the expensive phase
// agents but exactly wrong for a re-read of state.json that changed
// on-disk since the cached run. Stamping the launch counter into those
// read prompts changes their cache key per launch, so they run live and
// see the current file, while phase-agent caching is preserved. A bare
// slash-command run (no object args) has no launch; it defaults to 1,
// which is correct because such a run never resumes a prior run.
function parseArgs(rawArgs) {
  let value = rawArgs;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      value = JSON.parse(value);
    } catch {
      // Not JSON after all; fall through to token parsing.
    }
  }
  if (typeof value === "object" && value !== null) {
    return {
      issue: value.issueNumber,
      mode: value.mode,
      answer: value.answer,
      directive: value.directive,
      launch: typeof value.launch === "number" ? value.launch : 1,
    };
  }
  const tokens = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  return { issue: tokens[0], mode: tokens[1], answer: undefined, directive: undefined, launch: 1 };
}

const parsed = parseArgs(args);
const issue = parsed.issue;
if (!issue) {
  throw new Error(
    'Missing issue number. Pass args: { issueNumber: N, mode: "auto"|"semi-auto"|"manual"|"merge" }, or "N" / "N manual".',
  );
}

// Set the per-launch nonce before any mutable-state read runs (see
// LAUNCH/BUMP/cacheBust). Every read of on-disk state after this point is
// stamped with the launch counter so a resume relaunch re-reads live
// instead of replaying a stale cached snapshot.
LAUNCH = parsed.launch;

const { root, dir } = await resolvePaths(issue);

// merge is a standalone terminal action, resolved before any state
// bootstrap or phase logic.
if (parsed.mode === "merge") {
  const state = await readState(dir);
  if (!state || state.status !== "human-review") {
    throw new Error(
      `Issue ${issue} is at ${state?.status ?? "no state"}, not human-review. Refusing to merge until a human reached that gate.`,
    );
  }
  const pr = await findLinkedPr(issue);
  if (!pr) {
    throw new Error(`Issue ${issue} is at human-review but no linked pull request was found.`);
  }
  await agent(`Run: gh pr merge ${pr} --squash --delete-branch`, { label: "merge-pr", model: "haiku" });
  await transitionTo(root, issue, "closed");
  log(`Issue ${issue} merged pull request ${pr} (squash) and transitioned to closed.`);
  return { issue, status: "merged", pr };
}

// Bootstrap / load state. A caller-supplied mode word is written in (a
// rerun may change the mode); otherwise the persisted mode wins, and a
// brand-new issue defaults to semi-auto.
let state = await ensureState(dir, parsed.mode ?? "semi-auto");
if (parsed.mode && parsed.mode !== state.mode) {
  await patchState(dir, { mode: parsed.mode });
  state.mode = parsed.mode;
}
const mode = state.mode;
if (mode !== "auto" && mode !== "semi-auto" && mode !== "manual") {
  throw new Error(`Unknown mode "${mode}". Use "auto", "semi-auto", "manual", or "merge".`);
}

const buildDef = PHASE_DEFS.find((d) => d.key === "build");

// Set true only when the human answered a missing-dependency question
// with "proceed": the phase loop then runs that phase with whatever
// dependency artifacts exist and does not re-stop on the still-missing
// ones. Scoped to this one invocation (the decision is not persisted).
let proceedPastMissingDeps = false;

// ---- resume a pending question first, before any phase ----
//
// A relaunch that carries an answer/directive is resolving whatever
// pendingQuestion holds. We consume the persisted question, clear it,
// and route the answer as if it had just been raised. A relaunch with no
// answer/directive while a question is still pending re-stops (the shell
// will re-ask); it never guesses.
if (state.pendingQuestion) {
  const pq = state.pendingQuestion;
  const hasResponse = parsed.answer !== undefined || parsed.directive !== undefined;
  if (!hasResponse) {
    log(`Issue ${issue} still has an unanswered ${pq.kind} on the ${pq.phase} phase; re-stopping for the shell to re-ask.`);
    return {
      issue,
      status: pq.kind === "gate" ? "gate" : pq.kind === "dependency" ? "dependency" : "question",
      pendingQuestion: pq,
      gate: pq.kind === "gate" ? `${pq.phase}-awaiting-approval` : undefined,
    };
  }

  // Clear the question now that we have a response; every branch below
  // works from a cleared pendingQuestion.
  await patchState(dir, { pendingQuestion: null });
  state.pendingQuestion = null;

  const def = PHASE_DEFS.find((d) => d.key === pq.phase);

  if (pq.kind === "dependency") {
    // Proceed => fall through into the phase loop, but remember the
    // decision so the loop does not re-detect the same missing dependency
    // and stop again in a loop. Wait => stop cleanly.
    if (parsed.directive?.kind === "wait") {
      log(`Issue ${issue}: human chose to wait on the missing dependency; stopping without advancing.`);
      return { issue, status: "waiting", reason: "dependency" };
    }
    proceedPastMissingDeps = true;
    // Proceed: fall through to the phase loop below.
  } else if (pq.kind === "clarification") {
    // Re-run this phase's agent with the answer folded in. It may raise
    // another question (stop again), or finish (advance / gate).
    const { paths: depPaths } = await resolveDependencyPaths(root, state.dependsOn ?? []);
    const result = await runPhaseAgent(issue, dir, def, {
      mode,
      answer: parsed.answer,
      depPaths,
      prNumber: state.prNumber,
    });
    if (result.status === "clarification-needed") {
      return await stopForQuestion(dir, issue, def.key, result);
    }
    if (def.key === "qa") {
      // QA has its own gate / rejection-loop / verdict-transition, not the
      // generic advance. Verify the artifact and read the verdict in one
      // spawn, then hand off to the shared QA driver (which also handles
      // manual mode's gate).
      const { present, verdict } = await verifyQaAndReadVerdict(dir);
      if (!present) {
        throw new Error(`QA returned done but ${dir}/qa.md is missing or empty.`);
      }
      await patchState(dir, { qaVerdict: verdict });
      const driven = await driveQaFromVerdict(verdict);
      if (driven.stopped) {
        return driven.value;
      }
    } else {
      const advanced = await advancePhaseAfterAgent(def);
      if (advanced?.stopped) {
        return advanced.value;
      }
    }
    // The phase loop below re-reads state fresh (line "Re-read fresh …")
    // before iterating, so no separate read-state spawn is needed here.
  } else if (pq.kind === "gate") {
    // Manual-mode approve/revise on a written artifact.
    if (parsed.directive?.kind === "revise") {
      if (def.key === "qa") {
        await fixupBuild(issue, dir, buildDef, `${dir}/qa.md`, parsed.directive.feedback);
        // QA re-runs after the build fixup, then re-gates.
        const qaResult = await runPhaseAgent(issue, dir, PHASE_DEFS.find((d) => d.key === "qa"), {
          mode,
          depPaths: [],
          prNumber: state.prNumber,
        });
        if (qaResult.status === "clarification-needed") {
          return await stopForQuestion(dir, issue, "qa", qaResult);
        }
        await patchState(dir, { qaVerdict: await readQaVerdict(dir) });
        return await stopForGate(dir, issue, "qa", def.gateStatus);
      }
      const revised = await reviseArtifact(issue, dir, def, parsed.directive.feedback);
      if (revised.status === "clarification-needed") {
        return await stopForQuestion(dir, issue, def.key, revised);
      }
      return await stopForGate(dir, issue, def.key, def.gateStatus);
    }
    // approve: perform the real transition this phase produces, then
    // fall through into the phase loop for the next phase.
    if (def.key === "qa") {
      const verdict = state.qaVerdict ?? (await readQaVerdict(dir));
      await transitionTo(root, issue, verdict === "approved" ? "human-review" : "in-progress");
    } else {
      await transitionTo(root, issue, def.toStatus);
    }
    state = await readState(dir);
  }
}

// ---- the phase loop ----
//
// Runs the phase whose entryStatus matches the current status, advances,
// and continues, until a phase stops for a human decision or nothing is
// left to drive. `advancePhaseAfterAgent` centralises the post-agent
// artifact-check / gate / transition so the resume branch above and the
// loop share it.

// Given a def whose agent just returned "done", verify the artifact,
// apply the manual gate if any, otherwise transition to the next status.
// Returns { stopped: true, value } if it stopped for a human, or
// { stopped: false, state } to continue the loop (state is the fresh
// post-transition read, so the caller does not need its own read-state
// spawn). Only spec/plan/build reach here; QA advances via
// driveQaFromVerdict.
async function advancePhaseAfterAgent(def) {
  // Build records its linked PR before advancing. This is its own read
  // (of GitHub, not local state) and cannot fold into the local batch.
  if (def.key === "build") {
    const pr = await findLinkedPr(issue);
    if (pr) {
      await patchState(dir, { prNumber: pr });
    }
  }

  if (mode === "manual") {
    // Manual gate: verify the artifact and move to the gate status in one
    // batched call, then stop for the human.
    const gated = await verifyAndAdvance(dir, root, issue, def.artifact, def.gateStatus);
    return { stopped: true, value: await stopForGate(dir, issue, def.key, def.gateStatus), state: gated };
  }

  // auto / semi-auto: verify the artifact, run the real transition, and read
  // the fresh state, all in ONE spawn (was three: check-artifact +
  // transition + read-state).
  const state = await verifyAndAdvance(dir, root, issue, def.artifact, def.toStatus);
  return { stopped: false, state };
}

// Post-QA handling shared by the phase loop and the resume branch. Given
// the verdict already read from qa.md (and cached in state), it applies
// the manual gate, or the auto/semi-auto build -> QA rejection loop (up
// to MAX_QA_ROUNDS), or the final human-review/in-progress transition.
// Returns { stopped: true, value } to bubble a return up, or
// { stopped: false } when QA approved and the loop should continue.
async function driveQaFromVerdict(initialVerdict) {
  const qaDef = PHASE_DEFS.find((d) => d.key === "qa");
  let verdict = initialVerdict;

  if (mode === "manual") {
    await transitionTo(root, issue, qaDef.gateStatus);
    return { stopped: true, value: await stopForGate(dir, issue, "qa", qaDef.gateStatus) };
  }

  let round = 1;
  while (verdict === "rejected" && round < MAX_QA_ROUNDS) {
    round += 1;
    await transitionTo(root, issue, "in-progress");
    phase("Build");
    const fix = await fixupBuild(issue, dir, buildDef, `${dir}/qa.md`, null);
    if (fix.status === "clarification-needed") {
      // Only possible outside auto; surface it.
      return { stopped: true, value: await stopForQuestion(dir, issue, "build", fix) };
    }
    await transitionTo(root, issue, "ai-review");
    phase("QA");
    const result = await runPhaseAgent(issue, dir, qaDef, { mode, depPaths: [], prNumber: state.prNumber });
    if (result.status === "clarification-needed") {
      return { stopped: true, value: await stopForQuestion(dir, issue, "qa", result) };
    }
    verdict = await readQaVerdict(dir);
    await patchState(dir, { qaVerdict: verdict });
  }

  if (verdict === "rejected") {
    await transitionTo(root, issue, "in-progress");
    log(`Issue ${issue} still rejected after ${round} QA rounds; left at in-progress for a human.`);
    return { stopped: true, value: { issue, status: "rejected", rounds: round } };
  }
  await transitionTo(root, issue, "human-review");
  log(`Issue ${issue} QA approved after ${round} round(s).`);
  return { stopped: false };
}

// Re-read fresh in case the resume branch advanced us.
state = await readState(dir);

for (const def of PHASE_DEFS) {
  if (!def.entryStatus.includes(state.status)) {
    continue;
  }

  phase(def.label);

  // Dependency resolution (spec/plan/build read dependency artifacts).
  let depPaths = [];
  if (def.key !== "qa") {
    const deps = await resolveDependencyPaths(root, state.dependsOn ?? []);
    if (deps.missing.length > 0 && !proceedPastMissingDeps) {
      return await stopForDependency(dir, issue, deps.missing);
    }
    depPaths = deps.paths;
  }

  // Build's own entry transition (into in-progress), skipped if already there.
  if (def.startStatus && state.status !== def.startStatus) {
    await transitionTo(root, issue, def.startStatus);
    state = await readState(dir);
  }

  if (def.key === "qa") {
    const result = await runPhaseAgent(issue, dir, def, { mode, depPaths: [], prNumber: state.prNumber });
    if (result.status === "clarification-needed") {
      return await stopForQuestion(dir, issue, "qa", result);
    }
    // Verify qa.md and read its verdict in one spawn.
    const { present, verdict } = await verifyQaAndReadVerdict(dir);
    if (!present) {
      throw new Error(`QA returned done but ${dir}/qa.md is missing or empty.`);
    }
    await patchState(dir, { qaVerdict: verdict });
    const driven = await driveQaFromVerdict(verdict);
    if (driven.stopped) {
      return driven.value;
    }
    state = await readState(dir);
    continue;
  }

  // spec / plan / build: run the agent, possibly stop for a question,
  // else verify + gate/advance.
  const result = await runPhaseAgent(issue, dir, def, {
    mode,
    depPaths,
    prNumber: state.prNumber,
  });
  if (result.status === "clarification-needed") {
    return await stopForQuestion(dir, issue, def.key, result);
  }
  const advanced = await advancePhaseAfterAgent(def);
  if (advanced.stopped) {
    return advanced.value;
  }
  // advancePhaseAfterAgent already read the fresh post-transition state as
  // part of its batched call; reuse it instead of a separate read-state spawn.
  state = advanced.state;
}

log(`Issue ${issue} is at ${state.status}; nothing left for this workflow to drive.`);
return { issue, status: "done", state: state.status };
