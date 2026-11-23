#!/usr/bin/env bash
# Claude Code's Stop hook (.claude/settings.json): when Claude finishes a turn, commit whatever it changed, so
# every step is in git. It only commits: pushing stays a separate, deliberate step.
# Skipped: outside a git checkout, on main (work happens on a branch), during a merge or rebase, and when
# nothing changed. Files that .gitignore covers (keys, .env, build output) are never added.
set -u
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0   # a detached HEAD: leave it alone
case "$branch" in main|master) echo '{"systemMessage":"Auto-commit skipped: on main. Switch to a branch to have each change committed."}'; exit 0;; esac
gitdir=$(git rev-parse --git-dir)
for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do [ -e "$gitdir/$f" ] && exit 0; done
[ -z "$(git status --porcelain)" ] && exit 0
git add -A
files=$(git diff --cached --name-only | head -8 | paste -sd ', ' -)
count=$(git diff --cached --name-only | wc -l | tr -d ' ')
[ "$count" -gt 8 ] && files="$files, and $((count - 8)) more"
if git commit -q -m "Claude: changes from the last turn ($count file$([ "$count" = 1 ] || echo s))" -m "$files"; then
  echo "{\"systemMessage\":\"Committed $count file$([ "$count" = 1 ] || echo s) on $branch (not pushed).\"}"
fi
exit 0
