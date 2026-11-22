# Design PR review

Everything under `factory/ready/` is a **design folder**, not code. A PR that adds or changes one is a `design:` PR,
and it is where the architecture of the next feature is decided. After merge, an automated factory builds the feature
from this folder **without asking anyone anything**, so every gap you miss here becomes a guess in shipped code.
Review it as the most important PR in the repo.

## What a design folder holds

```text
factory/ready/<NNN>-<kebab-name>/
  Design.md               who it's for, intent, out of scope, ## Screens, ## Decisions, ## Done when
  screenshots/            <screen>--<state>.png, one per screen per state (per size, when the design has sizes)
  ApiContract.md          every endpoint the design calls (only if it calls any)
  ModelChanges.md         every stored field/table added, changed or removed (only if any)
  ImplementationPlan.md   ordered PRs: Changes, Tests, Screenshots it must match, "Done when" items it delivers
```

The design files are the truth. The plan only says how to build them.

## How to review

1. **You cannot see the PNGs.** Judge screenshot coverage from `Design.md` (its `## Screens` entries, image links,
   `## Decisions` and `## Done when`) and from the screenshot file names in the PR. Never claim a picture looks
   right or wrong.
2. **Check the plan against the real code.** You have the whole repo indexed. Every file, type, function, route,
   table or pattern the plan names must exist and behave as the plan assumes, or be clearly marked as new.
3. **Be adversarial about completeness and about excess, equally.** A missing state is a defect; so is a table,
   field, abstraction or PR the design never asked for. When the cost of a gap and the cost of the extra machinery
   are about even, prefer the simpler plan.
4. Say where: the file, the heading or PR number, and the line. Give the fix, not just the problem.

## Ignore

- The `<!-- factory: … -->` line in `ImplementationPlan.md`; a tool writes it.
- PRs that only move a folder from `factory/ready/` to `factory/done/`; there is nothing to review.
- Prose style, unless the wording is ambiguous enough that two implementers would build different things.
