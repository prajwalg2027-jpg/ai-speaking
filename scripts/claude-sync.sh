#!/usr/bin/env bash
# Claude Code's SessionStart and UserPromptSubmit hook (.claude/settings.json): before Claude starts work, bring
# in anything new on GitHub for this branch (made in a cloud session, on another computer, or merged on GitHub),
# so Claude always works on the latest. Unsaved work here is kept (it is set aside and put back).
# Quiet when there is nothing new. Never forces anything: if the two clash, it says so and changes nothing.
set -u
export GIT_TERMINAL_PROMPT=0   # never stop to ask for a password: a hook has no one to answer it
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
say() { printf '{"systemMessage":"%s"}\n' "$1"; }
branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || exit 0
gitdir=$(git rev-parse --git-dir)
for f in MERGE_HEAD REBASE_HEAD CHERRY_PICK_HEAD rebase-merge rebase-apply; do [ -e "$gitdir/$f" ] && exit 0; done
git remote get-url origin >/dev/null 2>&1 || exit 0
git fetch -q origin "$branch" 2>/dev/null || exit 0   # offline, or the branch is not on GitHub yet (the hook's own time limit stops a slow one)
behind=$(git rev-list --count "HEAD..origin/$branch" 2>/dev/null) || exit 0
[ "$behind" = 0 ] && exit 0
if git -c rebase.autoStash=true rebase -q "origin/$branch" >/dev/null 2>&1; then
  say "Brought in $behind new change$([ "$behind" = 1 ] || echo s) from GitHub ($branch)."
else
  git rebase --abort >/dev/null 2>&1
  say "GitHub has $behind new change$([ "$behind" = 1 ] || echo s) that clash with work here, so nothing was changed. Ask Claude to bring in the GitHub changes."
fi
exit 0
