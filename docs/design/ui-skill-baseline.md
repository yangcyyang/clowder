---
doc_kind: design
created: 2026-05-18
source: ui-skills baseline-ui + transitions-dev
---

# UI Skill Baseline

This note records the first Clowder UI rules imported from `baseline-ui` and
`transitions-dev`. It is a lightweight guardrail for future Slock-like UI work.

## Baseline Rules

- Prefer existing design tokens and Tailwind defaults before adding arbitrary
  values.
- Icon-only buttons must have an accessible label.
- Do not animate layout properties such as `width`, `height`, `top`, `left`,
  `margin`, or `padding`.
- Interaction feedback should stay at or below `200ms`.
- Motion must respect `prefers-reduced-motion`.
- New panel and modal transitions should use `transform` and `opacity` first.
- Avoid `transition-all` for new code; transition the exact properties needed.
- Avoid new gradients, glow effects, and extra accent colors unless the feature
  explicitly requires them.

## First Scan Findings

- `ThreadSidebar` still has several `tracking-[...]` and `transition-all`
  usages from earlier iterations. These are not P0 regressions, but should be
  cleaned when touching those areas.
- `ChatContainer` still has a few arbitrary z-index values for guide overlays.
  Keep them stable until a shared z-index scale is introduced.
- `InlineThreadPanel` was the highest-impact motion target because it appeared
  and disappeared instantly.

## Applied In This Task

- Installed project-local skills:
  - `.agents/skills/baseline-ui`
  - `.agents/skills/transitions-dev`
- Added a Thread panel transition using the `transitions-dev` panel-reveal idea,
  adapted for Clowder:
  - X-axis slide from the right.
  - `180ms ease-out`.
  - `transform + opacity` only.
  - `prefers-reduced-motion` guard.
- Added delayed unmount so close uses the same slide-out instead of disappearing
  immediately.

## Next Candidates

- Replace new `transition-all` usage with property-specific transitions.
- Add a small shared z-index scale for overlays, modals, and guide layers.
- Add keyboard/focus review for Thread panel open/close after the motion work is
  accepted.
