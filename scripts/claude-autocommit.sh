#!/usr/bin/env bash
# Claude Code's Stop hook (.claude/settings.json): when Claude finishes a turn, commit whatever it changed and
# push it to GitHub, so every step is saved there and every other copy (a cloud session, another computer)
# can pick it up. If GitHub has newer work, that is brought in first and then the push is made.
# Skipped: outside a git checkout, on main (work happens on a branch), during a merge or rebase, and when
# nothing changed. Files that .gitignore covers (keys, .env, build output) are never added.
set -u
export GIT_TERMINAL_PROMPT=0   # never stop to ask for a password: a hook has no one to answer it
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
say() { printf '{"systemMessage":"%s"}\n' "$1"; }
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0   # a detached HEAD: leave it alone
case "$branch" in main|master) say "Auto-save skipped: on main. Switch to a branch to have each change saved."; exit 0;; esac
gitdir=$(git rev-parse --git-dir)
for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do [ -e "$gitdir/$f" ] && exit 0; done

committed=""
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  count=$(git diff --cached --name-only | wc -l | tr -d ' ')
  files=$(git diff --cached --name-only | head -8 | tr '\n' ',' | sed 's/,$//; s/,/, /g')
  [ "$count" -gt 8 ] && files="$files, and $((count - 8)) more"
  git commit -q -m "Claude: changes from the last turn ($count file$([ "$count" = 1 ] || echo s))" -m "$files" && committed="$count file$([ "$count" = 1 ] || echo s)"
fi

# Push anything not yet on GitHub (this turn's commit, and any left over from before).
git remote get-url origin >/dev/null 2>&1 || { [ -n "$committed" ] && say "Committed $committed (no GitHub remote to push to)."; exit 0; }
git fetch -q origin "$branch" 2>/dev/null
ahead=$(git rev-list --count "origin/$branch..HEAD" 2>/dev/null || git rev-list --count HEAD)
[ "$ahead" = 0 ] && { [ -n "$committed" ] && say "Committed $committed."; exit 0; }
# GitHub has work this copy doesn't: bring it in first, keeping both.
if git rev-parse -q --verify "origin/$branch" >/dev/null && [ "$(git rev-list --count "HEAD..origin/$branch")" != 0 ]; then
  if ! git rebase -q "origin/$branch" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1
    say "Saved here, but not sent to GitHub: GitHub has other changes to the same lines. Ask Claude to sort out the conflict with GitHub."
    exit 0
  fi
fi
for attempt in 1 2 3; do
  if git push -q -u origin "$branch" 2>/dev/null; then say "Saved to GitHub ($branch)${committed:+: $committed}."; exit 0; fi
  sleep $((attempt * 2))
done
say "Saved here, but GitHub could not be reached. It will be sent with the next change."
exit 0
