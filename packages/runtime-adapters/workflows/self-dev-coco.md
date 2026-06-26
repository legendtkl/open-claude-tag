## Coco Runtime Appendix

- You are running in the `coco` (TRAE CLI / Codebase Copilot) runtime. Step 16 must spawn an independent review agent responsible for the review — the main implementation thread cannot treat its own self-check as the final review.
- Prefer Coco's own tooling for the review pass: run `coco -p /builtin:review <merge_request_url_or_number>` when a review request exists, or pipe the diff into a non-interactive Coco run (`git diff | coco --print --yolo "Review this diff for bugs, error handling, test coverage, and backward compatibility; rank findings critical/major/minor"`).
- The review agent must only evaluate, not implement. It must read `git diff --stat` and `git diff`, focusing on:
  - Correctness and potential bugs
  - Error handling completeness
  - Test coverage
  - Backward compatibility
- The review agent's conclusions must be returned to the main thread categorized as `critical / major / minor`.
- If any critical/major issues exist, they must be fixed before re-running build, test, and E2E.
- Minor issues may be noted and continued past, but must be explained in the final PR description.
- Coco authenticates via local git credentials and reads `~/.coco/coco.yaml` (or `~/.trae/traecli.yaml`) — never embed API keys in the repo. Select a model with `-c model.name=<model>` when a specific compliant model is required.
