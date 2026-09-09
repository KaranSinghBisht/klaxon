#!/usr/bin/env bash
# The shoot layout (build plan §8). One tmux window, three panes, so the "one worm, both repos"
# beat is a single frame: LEFT is the ordinary repo, RIGHT is the KLAXON-protected one, and a short
# aux pane underneath drives the push that triggers both.
#
#   LEFT  (ordinary-repo)  |  RIGHT (klaxon-repo)
#   -----------------------+----------------------
#            aux  (git push that hits both / verify on the second machine)
#
# Set the terminal font to 18 pt or larger BEFORE running — a hash has to be legible across the
# room. tmux cannot set the font; that is the terminal emulator's job.
#
# Usage:  demo/scripts/shoot.sh [ordinary-repo-dir] [klaxon-repo-dir]
set -euo pipefail

SESSION="klaxon-shoot"
ORDINARY="${1:-$HOME/klaxon-demo/ordinary-repo}"
KLAXON="${2:-$HOME/klaxon-demo/klaxon-repo}"

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "session $SESSION already exists — attaching. (tmux kill-session -t $SESSION to reset.)"
  exec tmux attach -t "$SESSION"
fi

tmux new-session  -d -s "$SESSION" -n shoot -c "$ORDINARY"
tmux split-window -h -t "$SESSION:shoot" -c "$KLAXON"          # RIGHT: klaxon-repo
tmux split-window -v -t "$SESSION:shoot.0" -c "$ORDINARY"      # aux under the LEFT
tmux select-layout -t "$SESSION:shoot" main-horizontal
tmux setw   -t "$SESSION:shoot" pane-border-status top
tmux setw   -t "$SESSION:shoot" pane-border-format " #P #{pane_current_path} "

# Label the panes but do not run anything — the operator drives each beat by hand so nothing is
# faked or sped up (ETHGlobal production rules).
tmux send-keys -t "$SESSION:shoot.0" 'clear; echo "LEFT  — ordinary-repo (the victim)"' C-m
tmux send-keys -t "$SESSION:shoot.1" 'clear; echo "RIGHT — klaxon-repo (protected)"'   C-m
tmux send-keys -t "$SESSION:shoot.2" 'clear; echo "aux   — one push hits both repos; verify runs on the second machine"' C-m

tmux select-pane -t "$SESSION:shoot.2"
exec tmux attach -t "$SESSION"
