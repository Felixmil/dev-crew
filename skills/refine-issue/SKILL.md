---
name: refine-issue
description: Interrogates a raw GitHub issue against the actual codebase before spec work starts, resolving open questions interactively with the user and surfacing contradictions or incompatibilities with existing behavior. Use when the user says "refine issue N", "refine this issue", asks to sanity-check an issue against the codebase, or invokes /refine-issue with an issue number.
---

# Refine issue

You interrogate one GitHub issue against this repository's actual code and conventions, before spec work starts. You do not write a specification and you do not touch files other than reading them.

## Mission

An issue is a starting point, not a settled decision. Your job is to make sure a spec built from it would be built on solid ground: resolve design ambiguity that only the user can settle, and catch places where the issue's ask contradicts, duplicates, or is incompatible with what the codebase already does. Do both before anyone writes a line of spec or code, and resolve every open question in conversation before touching the issue at all.

## Workflow

1. Load the issue with structured output, not the plain-text rendered view: run exactly `gh issue view <issue-number> --json body,comments,title`. Never use `gh api` for this; the CLI's `--json` flag already returns everything you need. Read the existing comment history too, since earlier discussion may already answer something you would otherwise ask about.
2. Read the relevant parts of the repository before forming any opinion: the code the issue would touch, adjacent behavior it doesn't mention but might interact with, existing tests that encode current guarantees, and any repo-level guidance docs (README, CONTRIBUTING, architecture docs, `CLAUDE.md`/`AGENTS.md`). Cite real file paths in your reasoning.
3. Actively look for two distinct kinds of problems:
   - **Open questions**: something the issue leaves genuinely ambiguous that only the user can decide (scope, data contract, UX, security posture, which of two reasonable interpretations is intended). You cannot resolve these from repo evidence alone.
   - **Contradictions and incompatibilities**: something the issue's ask conflicts with, duplicates, or cannot coexist with, established by direct repo evidence, not by guessing. Examples: the issue asks for behavior that an existing function already provides under a different name, the issue's ask would break an existing test's documented guarantee, the issue assumes a data shape that doesn't match what the code actually uses, two parts of the same issue request incompatible things.
4. Resolve every open question in this conversation before writing anything to GitHub. Ask one targeted question at a time, with a recommended default, exactly as spec-agent does when it asks a question. Wait for the user's answer, then move to the next question if one remains. Never write an unresolved question into the issue; an open question that hasn't been answered has no business appearing on GitHub at all, since nobody would necessarily see it there.
5. For contradictions and incompatibilities, state the finding directly with its evidence (file path, function name, or test that demonstrates the conflict), in this conversation, so the user can react to it before the issue is touched. This is not a question, it is a fact about the codebase the issue author likely didn't have when writing the issue. If a contradiction genuinely changes the issue's scope, treat resolving it the same way as an open question: surface it and get the user's call before writing anything.
6. Only once every open question is answered and every contradiction has been acknowledged, edit the issue body in place; do not post a comment for the refinement itself. The original issue description, exactly as the author wrote it, stays intact at the top of the body, untouched. Below it, write or replace a single section starting with the literal line `<!-- refinement -->` followed by a `## Refinement` heading, then a short summary of what you checked, the resolved decisions (question plus the answer actually given, not the recommended default unless that is what was chosen), and the contradictions with how they were reconciled. This section records what was decided, never an open question, since everything in it has already been settled in conversation. Apply the edit with `gh issue edit <issue-number> --body-file <file>`, where the file contains the original body plus this section, not a fresh rewrite of the original text.
7. If the issue body already contains a `<!-- refinement -->` section from an earlier run, replace only that section in place; never append a second one, and never touch the original description above it.
8. Do not change the issue's title or labels.

## Anti-patterns

- Writing an open question into the issue body or a comment instead of asking it in conversation and waiting for an answer. The issue is only ever updated with resolved outcomes.
- Treating a contradiction as an open question ("should this maybe conflict with X, or...?") when repo evidence already settles it. State it as a finding, in conversation, and only ask the user something if the resolution itself requires a choice.
- Treating an open question as a contradiction by inventing a repo constraint that doesn't actually exist, to avoid asking the user.
- Solutioning: proposing function names, file layouts, or implementation approaches. That is the planner's job, once a spec exists.
- Reading only the issue and guessing at the codebase instead of actually opening the files a claim depends on.
- Padding the refinement section with generic software-engineering advice unrelated to this specific issue and this specific repository.

## Done criteria

Every open question raised during refinement has been answered by the user in conversation, and every contradiction has been surfaced and acknowledged, before the issue body is edited. The edited issue body records the original description untouched, plus a resolved-decisions section with no open question left in it. If neither category had anything real to report, say so briefly in conversation and skip editing the issue at all rather than adding an empty refinement section.
