---
name: create-local-issue
description: Creates a local issue that lives only on the filesystem under <repo>.issues/, never on GitHub, so you can drive the spec -> plan -> build -> QA pipeline on work that has no GitHub issue. Assigns an L-prefixed id (L1, L2, ...) distinct from GitHub issue numbers, writes an issue.md holding the title and description, and seeds state.json. Use when the user says "create a local issue", "make a local issue", "new local issue", or invokes /create-local-issue (optionally with a title/description).
---

# Create local issue

You create a **local issue**: a per-issue folder under `<repo>.issues/` that behaves like a GitHub-backed issue for the pipeline and refine skills, but has no GitHub issue behind it. Its description lives in a local `issue.md` instead of a GitHub issue body. It gets an **L-prefixed id** (`L1`, `L2`, ...) so it can never collide with a numeric GitHub issue number sharing the same folder.

After this skill runs you can refine it (`/refine-issue L3`) and drive the full pipeline on it (`/run-pipeline L3`), exactly as you would a GitHub issue; those skills detect the `L` prefix and read `issue.md` instead of GitHub.

## Steps

1. **Derive the state root from git** (identical to the run-pipeline skill, so both agree on where folders live):
   - `git rev-parse --show-toplevel` gives the working-tree root; its basename is `<repo>`, its parent is `<parent>`.
   - The state root is `<parent>/<repo>.issues`. Example: a repo at `~/Code/rollr2` gives `~/Code/rollr2.issues`.
   - Inside a worktree, use `git rev-parse --git-common-dir` to resolve the canonical main-checkout name, so all worktrees share one root.

2. **Pick the next local id.** List the existing local-issue folders: the ones under `<root>/` whose name matches `^L[0-9]+$`. Take the highest number among them and add 1; if there are none, start at `1`. The new id is `L<n>` (e.g. `L3`). Do **not** consider numeric (GitHub) folders when computing this; local and GitHub ids share the folder but not the numbering.

3. **Get the title and description.**
   - If the invocation passed text, use its first line as the title and the rest as the description.
   - Otherwise ask the user, inline, for a one-line title and a description (via `AskUserQuestion` if a structured prompt fits, or a plain question). Do not invent a description; a local issue with an empty description is not useful for the spec agent.

4. **Create the folder and files.**
   - `mkdir -p <root>/<id>/`.
   - Write `<root>/<id>/issue.md` as the local stand-in for a GitHub issue body:
     ```
     # <title>

     <description>
     ```
     This is the file `refine-issue` and the pipeline agents read for a local issue, in place of `gh issue view`.
   - Seed `<root>/<id>/state.json`:
     ```json
     {
       "status": "open",
       "mode": "semi-auto",
       "local": true,
       "prNumber": null,
       "qaVerdict": null,
       "pendingQuestion": null,
       "dependsOn": []
     }
     ```
     The `local: true` marker lets downstream tooling detect a local issue without re-parsing the id. (The `L` prefix on the id is the primary signal; `local` is a convenience mirror of it.)

5. **Never `git add`** the folder or any file in it; like every `<repo>.issues/` file, it lives outside the repo tree by construction and is never committed or pushed.

6. **Report the id** clearly to the user, with the next steps:
   ```
   Created local issue <id> at <root>/<id>/.
   Refine it:      /refine-issue <id>
   Run pipeline:   /run-pipeline <id>
   ```

## Anti-patterns

- Reusing or guessing an id without scanning `<root>/` first; always compute `max(existing L#) + 1` so two creates never collide.
- Numbering a local issue with a bare integer; that could collide with a GitHub issue folder. Always use the `L` prefix.
- Writing an empty or placeholder `issue.md`; get a real title and description first.
- `git add`ing anything under `<repo>.issues/`.
- Creating the folder anywhere other than the git-derived `<repo>.issues/` root.

## Done criteria

A new `<root>/L<n>/` folder exists with a non-empty `issue.md` (title + description) and a seeded `state.json` carrying `status: open`, `local: true`, and the standard fields. The id is reported to the user along with the refine and pipeline commands. Nothing was written to GitHub, and nothing was `git add`ed.
