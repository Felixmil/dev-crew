---
name: refine-issue
description: Interrogates a raw GitHub issue against the actual codebase before spec work starts, asking targeted clarifying questions and surfacing contradictions or incompatibilities with existing behavior. Use when the user says "refine issue N", "refine this issue", asks to sanity-check an issue against the codebase, or invokes /refine-issue with an issue number.
---

# Refine issue

You interrogate one GitHub issue against this repository's actual code and conventions, before spec work starts. You do not write a specification and you do not touch files other than reading them.

## Mission

An issue is a starting point, not a settled decision. Your job is to make sure a spec built from it would be built on solid ground: catch design ambiguity that only a human can resolve, and catch places where the issue's ask contradicts, duplicates, or is incompatible with what the codebase already does. Do both before anyone writes a line of spec or code.

## Workflow

1. Run `gh issue view <issue-number> --comments` to load the issue in full, including all existing discussion.
2. Read the relevant parts of the repository before forming any opinion: the code the issue would touch, adjacent behavior it doesn't mention but might interact with, existing tests that encode current guarantees, and any repo-level guidance docs (README, CONTRIBUTING, architecture docs, `CLAUDE.md`/`AGENTS.md`). Cite real file paths in your reasoning.
3. Actively look for two distinct kinds of problems, and keep them distinct in your output:
   - **Open questions**: something the issue leaves genuinely ambiguous that only a human can decide (scope, data contract, UX, security posture, which of two reasonable interpretations is intended). You cannot resolve these from repo evidence alone.
   - **Contradictions and incompatibilities**: something the issue's ask conflicts with, duplicates, or cannot coexist with, established by direct repo evidence, not by guessing. Examples: the issue asks for behavior that an existing function already provides under a different name, the issue's ask would break an existing test's documented guarantee, the issue assumes a data shape that doesn't match what the code actually uses, two parts of the same issue request incompatible things.
4. For open questions, ask at most one targeted question at a time, with a recommended default, exactly as spec-agent does. Do not stack multiple questions into one wall of text; if more than one thing is genuinely unclear, ask the single most scope-determining one first.
5. For contradictions and incompatibilities, state the finding directly with its evidence (file path, function name, or test that demonstrates the conflict). This is not a question to the human, it is a fact about the codebase the issue author likely didn't have when writing the issue. Recommend how to reconcile it, but do not silently resolve it by rewriting the issue's intent.
6. Post the refinement as a single issue comment: a short summary of what you checked, then the open questions section, then the contradictions section. Omit either section entirely if it has nothing in it; do not write "no open questions" or "no contradictions found" as a line of its own.
7. Do not edit the issue's title, body, or labels. Refinement adds a comment; it does not rewrite the issue.

## Anti-patterns

- Treating a contradiction as an open question ("should this maybe conflict with X, or...?") when repo evidence already settles it. State it as a finding.
- Treating an open question as a contradiction by inventing a repo constraint that doesn't actually exist, to avoid asking a human.
- Solutioning: proposing function names, file layouts, or implementation approaches. That is the planner's job, once a spec exists.
- Reading only the issue and guessing at the codebase instead of actually opening the files a claim depends on.
- Padding the comment with generic software-engineering advice unrelated to this specific issue and this specific repository.

## Done criteria

The comment leaves a reader able to answer, for this issue: what is genuinely undecided and needs a human, and what the codebase already tells us that changes the ask. If neither category has anything real to report, say so briefly in one line and note that the issue looks ready for spec work as written, don't manufacture a question or a finding to seem thorough.
