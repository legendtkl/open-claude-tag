## Claude Runtime Appendix

- You are running in the `claude_code` runtime with access to Claude Code's default tool capabilities and preset system prompt.
- Step 16 must use codex to review the current diff:
  ```bash
  git diff | codex --full-auto "Please review the following git diff. Check: 1) code correctness and potential bugs; 2) completeness of error handling; 3) adherence to project conventions and existing patterns; 4) sufficient test coverage. Provide specific improvement suggestions ranked by priority (critical / major / minor)."
  ```
- If codex review raises any critical / major issues, fix them and re-validate before proceeding.
