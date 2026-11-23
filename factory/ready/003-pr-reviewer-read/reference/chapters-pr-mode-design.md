# Chapters: PR mode (`chapters pr`)

**Status:** draft design, 2026-10-23, waiting for the user's review. It extends `2026-10-20-chapters-mvp-design.md`. It's built in parallel with M8, and M8 merges first.

## 1. Goal

Point Chapters at a pull request without checking it out:

```text
chapters pr <number | #number | PR URL> [--port 4173] [--regenerate] [--no-open] [--repos-dir <dir>]
```

PR mode is read-only. The MVP spec leaves GitHub integration out of scope, and this keeps the rest of it out:
- no comments or review state on GitHub;
- no writes to GitHub at all;
- no PR list or search.

**Update 2026-10-26:** `2026-10-26-github-review-design.md` lifts the first two rules for one feature. You can submit your own review comments and a verdict as a GitHub review, and only by clicking Submit.

## 2. Why fetch, and not the API alone

GitHub's API gives the final diff and the commit list. It doesn't give per-line ownership, which Chapters is built on. Rebuilding ownership from per-commit patches is unreliable, because the API truncates large diffs, leaves out patches for big files, and makes renames hard to follow.

`git blame` needs the commit objects. Extract already works from explicit `baseSha`/`headSha` (blame, diff and log all take `base..head`), so a **fetch** is enough. Nothing is checked out. In a partial clone (blobless or PR-only), extract first fetches, in one batch, both sides of every file change the commits in `base..head` make (added 2026-11-15). Left to fetch each blob on demand, blame made one fetch per blob, and the 50th pack ran git's auto gc, whose repack failed the fetches of the blames running alongside.

## 3. Flow

1. **Parse the argument.**
   - `123` and `#123` refer to a PR on the repo of the current directory. `gh` resolves it from the remotes, so you must be inside a clone.
   - A URL `https://<host>/<owner>/<repo>/pull/<n>` works from anywhere.
   - Anything else is a `UserError` showing the accepted forms.
2. **Look up the PR.** Run `gh pr view <arg> --json number,title,url,state,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository`.
   - `gh` handles authentication, for github.com and for GHE hosts. Chapters never reads GitHub tokens itself.
   - If `gh` is missing, the error says how to install it.
   - If `gh` isn't logged in, the error says `gh auth login --hostname <host>`.
   - A closed or merged PR still works, with a note.
3. **Find a local repo.**
   - **Inside a clone:** when the current directory is inside a git repo with a remote whose normalised URL (`ssh` or `https`, with or without `.git`) is `<host>/<owner>/<repo>`, use that repo and that remote.
   - **Otherwise:** use a bare clone at `<reposDir>/<host>/<owner>/<repo>.git`.
     - `reposDir` is `--repos-dir`, else `CHAPTERS_REPOS_DIR`, else `$XDG_CACHE_HOME/chapters/repos` (if `XDG_CACHE_HOME` is an absolute path; a relative one is ignored, per the XDG Base Directory spec), else `~/.cache/chapters/repos`.
     - Each run that uses the bare clone first removes `<path>.partial-<pid>-<8 hex>` directories older than an hour, which interrupted runs left behind. It matches only names the clone step below generates.
     - The first time, run `gh repo clone https://<host>/<owner>/<repo> <path>.partial-<pid>-<8 hex> -- --bare --filter=blob:none --quiet` (blobless, with gh's credential helper saved in the clone for the blob fetches; added 2026-10-26 so core-sized repos work), then rename it to `<path>`, so an interrupted clone never looks like a clone. Print `cloning <owner>/<repo> into <path> (first time only)`.
4. **Fetch into private refs.** Run `git fetch <flags> <remote> +refs/pull/<n>/head:refs/chapters/pr/<n>/head +refs/heads/<base>:refs/chapters/pr/<n>/base` (the flags are in §5).
   - These refs never touch your branches, your remote-tracking refs, HEAD, the index or the working tree. Fork PRs work, because GitHub publishes `refs/pull/<n>/head` on the base repo.
   - If the fetched head differs from `headRefOid` (a push landed in between), use the fetched SHA and print a note.
   - **Which base.** The base depends on the PR's state:
     - An **open** PR is compared against its base branch, which must exist.
     - A **merged** PR is compared against `baseRefOid`, the base GitHub recorded at the merge. The base branch now contains the PR, so comparing against it would show nothing. If the commit isn't in the repo yet, it is fetched by SHA into `refs/chapters/pr/<n>/base` (GitHub serves any commit of the repo). If it can't be fetched, chapters refuses rather than compare against the branch: `PR #<n> is merged, and its recorded base <sha7> could not be fetched (<git's last stderr line>); comparing against <base> as it is now would show nothing, because the PR is in it`.
     - A **closed** PR is compared against its base branch while the branch exists. Once the branch is deleted (a stacked PR's base, say), it is compared against `baseRefOid`, the tip GitHub last recorded, fetched by SHA if needed, with the note `PR #<n>'s base branch <base> has been deleted; comparing against its last recorded tip <sha7>`. If that commit can't be fetched either, chapters refuses: `PR #<n>'s base branch "<base>" has been deleted, and its last recorded tip <sha7> could not be fetched (<git's last stderr line>)`.
     - For merged and closed PRs, `git ls-remote --exit-code` first checks whether the base branch still exists (exit 2 means it doesn't; on success the exact `refs/heads/<base>` must appear in its output, since its patterns match name tails), because one missing ref fails the whole fetch. When it doesn't, the fetch leaves out the base refspec.
     - When the comparison uses `baseRefOid`, `refs/chapters/pr/<n>/base` is kept only if it names that commit, which keeps it reachable. Otherwise it is deleted.
5. **Generate and serve.** Use the same pipeline and storage as today, with an explicit target instead of "the HEAD of the current directory":
   - `headSha` is the resolved `refs/chapters/pr/<n>/head`;
   - `baseSha` is the merge base of the head and the base from step 4: `refs/chapters/pr/<n>/base`, or `baseRefOid` for a merged PR and for a closed PR whose base branch is gone;
   - files live under `<gitDir>/chapters/` as today. This works for bare repos too, where gitDir is the repo directory.
   - chapters.json gets `repo: "<repo>"`, `branch: <headRefName>`, `baseRef: <baseRefName>`, and a new optional `pr: { number, title, url, host, owner, repo }`. Older files without it stay valid.
6. **Re-run the same command** after the PR gets new commits. It fetches again, finds a new head SHA, and generates, reusing cached stages whose inputs haven't changed. Reviewed state is per head (MVP §8), so it starts fresh.

## 4. Target abstraction (the main code change)

Today `generate()` and `serve` get `headSha`, the repo name and the branch from the working directory (`rev-parse HEAD`, `--show-toplevel`, `symbolic-ref`). `--show-toplevel` fails in a bare repo.

PR mode introduces a resolved target, `{ gitCwd, headSha, headRef, baseRef, baseName, repo, branch, pr? }`:
- **Local mode** builds it the way generate and serve do today, so behaviour doesn't change.
- **PR mode** builds it from steps 2–4.
- **Serve** pins `target.headSha`. "Current head" for `/api/chapters` comes from a resolver: `rev-parse HEAD` in local mode, and `rev-parse refs/chapters/pr/<n>/head` in PR mode. The PR-mode ref only moves when `chapters pr` fetches again.
- Re-runs from `/qa` use the pinned target. The existing `expectHead` check uses the same resolver.
- **Rerun hint.** When the head ref has moved or no longer exists, the refusal says `PR #<n> has new commits (<old7> → <new7>); rerun chapters pr <url>` (or `refs/chapters/pr/<n>/head no longer exists; rerun chapters pr <url>`), and the page's banner says "This PR has new commits — rerun `chapters pr <url>`". The hint uses the PR's URL, not its number, because the URL works from any directory and a number only works inside a clone.

## 5. Safety

- PR mode writes only:
  - refs under `refs/chapters/pr/`;
  - files under `<gitDir>/chapters/`;
  - bare clones under `reposDir`.
- Tests assert that in the user's clone, HEAD, branches, the index, the working tree and the remotes config are unchanged.
- External commands run without a shell (`execFile`), with `--end-of-options` where a ref comes from user input. The owner, repo and number parsed from a URL are checked against `^[A-Za-z0-9._-]+$` and `^\d+$`.
- Every fetch runs `git fetch --quiet --no-tags --refmap= --no-write-fetch-head --no-auto-gc --no-prune --recurse-submodules=no --end-of-options <remote> <refspecs>`. `--refmap=` keeps remote-tracking refs where they are, and `--no-write-fetch-head` leaves `FETCH_HEAD` alone. No gc, no prune and no submodule fetches run in the user's clone. Fetches into chapters' own bare clones also get `-c credential.helper= -c 'credential.helper=!gh auth git-credential'`, for that command only.
- Only `https` and `ssh` remotes (and scp-like `host:owner/repo`) count as the PR's repo. Plaintext `http://` and `git://` never do, and neither does a remote whose URL a `url.<base>.insteadOf` rule rewrites to one, because git fetches from the rewritten URL (`git ls-remote --get-url <remote>` shows it).
- Data classification is unchanged: internal code only. PR mode makes it easy to point Chapters at any repo, so the README warning goes next to the `chapters pr` docs.
- The LLM rules are unchanged (gateway only, never api.anthropic.com).

## 6. Testing (offline)

- `gh` sits behind a small `GhClient` interface (`viewPr`, `cloneBare`), with a fake in tests. A live `gh` runs only at the QA checkpoint.
- The "remote" is a local bare repo built with `makeRepo`, with `git update-ref refs/pull/<n>/head <sha>` standing in for GitHub. Clone and fetch then use real git end to end.
- Cases:
  - number, `#number` and URL forms;
  - inside a matching clone versus a bare clone;
  - the first clone versus a reused one;
  - a fork-style PR (the head isn't on any branch);
  - a push between the view and the fetch;
  - a closed PR;
  - `gh` missing or not logged in;
  - a malformed URL;
  - re-running after new commits (stages reused, new head);
  - the user's clone left untouched;
  - serve's current-head resolver in PR mode.

## 7. Parallel-build constraints (M8 is in flight)

- Start from current `main`. **Don't edit** `ui/src/app/*`, `README.md` or `08-polish.md` until M8 has merged.
- Keep changes to `serve.ts`, `generate.ts` and `args.ts`/USAGE as small and additive as possible. Expect to rebase onto M8.
- **After M8 merges:**
  1. Rebase.
  2. Add the UI touch: the header shows `PR #<n>: <title>` linking to `pr.url` when `pr` is present, and the stale-HEAD banner says "This PR has new commits — rerun `chapters pr <url>`".
  3. Add the README section.
  4. Run the live QA on 2–3 real PRs, at least one of them from outside a clone.

## 8. PR-only fetch for huge repos (added 2026-10-26)

Even blobless, the first clone of `core-2206/core-260-public` (21 GB on GitHub) took 13 minutes and 4.4 GB. A **PR-only** repo takes about 30 s and 93 MB, because it fetches one tree snapshot (the merge base) and the PR's own commits.

**Choosing the mode.** This applies only outside a clone. Inside a clone nothing changes.
- **No repo at the bare path yet:** run `gh api repos/<o>/<r> --hostname <host> --jq '{size: .size}'`. GitHub reports the size in KB.
  - Up to `PR_ONLY_ABOVE_KB` (1 GiB): make the blobless full clone, as in §3. It prints `cloning <o>/<r> (<size>) into <path> (first time only)`.
  - Above it: make a PR-only repo at the same path. It prints `<o>/<r> is <size>: fetching only PR #<n>`.
  - Either line prints before the long step starts.
- **A repo is already there:** it keeps its mode. `git rev-parse --is-shallow-repository` says `true` only for a PR-only repo, so nothing new is stored, and existing full or blobless clones go on working.
  - A PR-only repo prints `fetching only PR #<n> into <path>` before it fetches, since a new merge base takes a while.
  - (Even a merge base that is a root commit is written to the shallow file by a depth-1 fetch; checked on git 2.50.)
- Sizes print in KB, MB or GB (powers of 1024, rounded), so core reads `20 GB`.
- **Creating a PR-only repo:**
  - It is set up in a `.partial-*` sibling: `git init --bare`, `remote.origin.url = https://<slug>.git`, the partial-clone settings `git clone --filter=blob:none` writes (`core.repositoryformatversion = 1`, `remote.origin.promisor = true`, `remote.origin.partialclonefilter = blob:none`), and `GH_CREDENTIALS` in its config so that on-demand blob fetches authenticate through gh.
  - The first PR is fetched into that sibling, which makes it shallow, and only then is it renamed into place. So a repo at the bare path that isn't shallow is always a full clone, and an interrupted first fetch leaves no repo behind.
  - If another run renamed its own repo into place first, this run fetches again into that one.

**Fetching a PR into a PR-only repo** (`src/pr/prOnly.ts`, built on `fetch.ts`'s fetch helper):
1. **The base tip.**
   - An OPEN PR uses the base branch's current tip, read with `git ls-remote`. A missing branch is an error.
   - A MERGED PR uses `baseRefOid`.
   - A CLOSED PR uses the branch tip if the branch still exists. Otherwise it uses `baseRefOid`, with the same note as `fetchPr`.
2. **Compare.** Run `gh api --paginate 'repos/<o>/<r>/compare/<tip>...<head>?per_page=100' --jq '{merge_base: .merge_base_commit.sha, ahead_by, commits: [.commits[] | {sha, parents: [.parents[].sha]}]}'`, where `<head>` is gh's `headRefOid`.
   - It prints one object per page. Each one is parsed with zod, the pages must agree on `merge_base` and `ahead_by`, and their commits are joined.
   - `ahead_by` is the PR's commit count, and the commits must number exactly that. If they don't, the error says the list was incomplete.
   - If the head is already in the base, the merge base is the head and `ahead_by` is 0. Extract then says `no commits on <branch> since <base>`, the same as a full clone.
3. **Check connectivity before fetching anything big.** Every parent of a PR commit must be another PR commit or the merge base.
   - A PR that merged its base branch into itself fails this check. Its earlier commits sit on a fork point that isn't the merge base, and in a repo that is shallow at the merge base, that fork point connects to nothing.
   - **Decision: a `UserError`, not a deepen.** Joining that history up would mean fetching the base branch from the fork point to the merge base. In core that can be thousands of commits, and with merges the depth needed can't be known exactly up front. The error names the PR, says it merges its base branch into itself, and says to run `chapters pr` from inside a clone of `<o>/<r>`, where nothing is shallow.
   - Deepening could come later if this is common: compare `<fork point>...<merge base>` gives a bound for `fetch --deepen`.
4. **The merge base.** "Already here" is asked with `git rev-list --no-walk --missing=print <sha>`, which prints `?<sha>` for a missing commit. It must not be `rev-parse` or `cat-file`: in a partial repo, those fetch a missing commit on demand, with all of its history. An experiment confirmed it. If the commit is already here, point `refs/chapters/pr/<n>/base` at it with `update-ref`. Otherwise fetch `--filter=blob:none --depth=1 +<mergeBase>:refs/chapters/pr/<n>/base`.
   - When the merge base changes (a rebase, say), the next run fetches the new one, and the shallow file grows by one entry. Shared trees aren't sent again.
   - Before any fetch, both SHAs from GitHub (the merge base and `headRefOid`), and every SHA in the commit list, are checked against the SHA pattern.
5. **The head, by SHA and with no depth.** If the head isn't here yet, fetch `--filter=blob:none +<headRefOid>:refs/chapters/pr/<n>/head`; if it is, `update-ref`. Then check that the ref is that SHA.
   - **Why no depth:** a later `--depth` fetch marks its boundary shallow even where history is already complete. In an experiment, a stacked PR's fetch at depth 2 cut the earlier PR's history at its head.
   - With step 3's check passed, a fetch without a depth stops at the merge base and at commits already here, so it brings exactly the PR's commits.
   - **Why by SHA, not `refs/pull/<n>/head`:** what's fetched is exactly what was compared and checked. Otherwise a force push in between could bring a disconnected history, and step 3 is there to prevent exactly that.
   - GitHub serves any of the repo's commits by SHA, which `fetchPr` already relies on for a merged PR's base. A push after `gh pr view` shows up on the next run.
6. **Check the result.** The merge base must be an ancestor of the head, and `git rev-list --count <mergeBase>..<head>` must equal `ahead_by`. Both only read commits that are already here.
   - **One repair, for stacked PRs fetched top first.** When PR 2 is stacked on PR 1 and PR 2 is fetched first, PR 1's head is PR 2's merge base, so it arrives at depth 1 and is shallow. Fetching PR 1 later finds its head already here but cut off, and the checks fail.
   - So when the checks fail, the cut commits are the PR commits in the shallow file. Fetch their parents that aren't here, by SHA and with no depth, then take the cut commits out of the shallow file (through `shallow.lock`, as git does) and check again. After step 3, those parents reach only PR commits and the merge base, so the fetch brings PR commits only and marks nothing shallow; the merge base and other PRs' ranges are untouched.
   - **Why not `--depth`:** an earlier version fetched the head again with `--depth=<longest path + 1>`. With an uneven merge inside the PR, git counts depth along the shortest path, so that fetch went past the merge base, brought base-branch commits and marked them shallow.
   - If the lock is held, it's a `UserError` saying another git is updating the repo; the next run repairs. If the checks still fail, it's a `UserError` (the same message as step 3).
   - Only step 4 fetches with a depth, and a re-run of a cached PR fetches nothing.
7. **Result.** Return `{ headSha, baseRef: <mergeBase SHA> }`. `extractStage`, `serve.prBase` and `extract` all call `mergeBase(baseRef, head)`, which gives the SHA back.

**Kept from `fetch.ts`:** `--refmap=`, `--no-write-fetch-head`, `--no-auto-gc`, `--no-tags`, `--no-prune`, `--recurse-submodules=no`, `--end-of-options`, the `refs/chapters/pr/<n>/{head,base}` refs, and the base-name check. Every git command passes `GH_CREDENTIALS` as `-c`, and the repo's config has them as well.

**Errors.** `gh api` failures go through `ghFailure`, as `viewPr`'s do:
- not logged in gives the `gh auth login --hostname <host>` advice;
- `HTTP 404` gives `gh api <path> failed: not found (HTTP 404); check the URL, and that gh's account on <host> can read the repo`;
- anything else gives gh's own stderr.

Messages never include stdout, which carries the response body.

**Tests.**
- The fake gh, both the binary and the in-process one, answers `api`:
  - the repo size comes from the test;
  - compare is computed with real `git merge-base`, `rev-list --count` and `rev-list --parents` on the fake upstream.
- The upstream allows filters and any-SHA wants, and tests reach it at a `file://` URL, so fetches really are partial and shallow.
- Cases:
  - a small repo gives a blobless clone, and a large one gives PR-only;
  - an existing repo keeps its mode;
  - open, merged and closed (base deleted) PRs;
  - a second run after new commits;
  - a PR with a merge from its base: the error comes before the head is fetched, and no base history arrives;
  - stacked PRs in one repo, fetched in either order, where neither cuts the other's history;
  - a push after `gh pr view`: the compared head is used, and the next run picks up the push;
  - gh api errors;
  - the e2e PR test in both modes.

## 9. Out of scope

- Posting anything to GitHub, except a review you submit (see `2026-10-26-github-review-design.md`).
- Listing or choosing PRs.
- Pruning old `refs/chapters/pr/*` refs or bare clones (the README documents `git update-ref -d` and `rm -rf`).
- Hosts other than GitHub and GitHub Enterprise.
- Running without `gh`.
