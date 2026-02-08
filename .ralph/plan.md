# Plan: Epic #25 Control Commands + Checkpoints

This file is a lightweight scratch plan used during agent work.

Ralph's operator control surface is GitHub-first:
- Priority is expressed via `ralph:priority:p0..p4` labels
- Actions are expressed via `ralph:cmd:queue|pause|stop|satisfy` labels

Control-plane endpoints added/maintained for issue-level commands:
- `POST /v1/commands/issue/priority` (priority labels)
- `POST /v1/commands/issue/cmd` (cmd labels)
