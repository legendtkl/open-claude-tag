## Codex Runtime Appendix

- You are running in the `codex` runtime. Step 16 must spawn an independent review agent responsible for the review — the main implementation thread cannot treat its own self-check as the final review.
- The review agent must only evaluate, not implement. It must read `git diff --stat` and `git diff`, focusing on:
  - Correctness and potential bugs
  - Error handling completeness
  - Test coverage
  - Backward compatibility
- The review agent's conclusions must be returned to the main thread categorized as `critical / major / minor`.
- If any critical/major issues exist, they must be fixed before re-running build, test, and E2E.
- Minor issues may be noted and continued past, but must be explained in the final PR description.
