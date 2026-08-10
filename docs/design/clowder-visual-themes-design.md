---
doc_kind: design
created: 2026-05-18
feature_ids: []
source:
  - awesome-claude-design/design-md/claude.DESIGN.md
  - awesome-claude-design/design-md/slack.DESIGN.md
  - /Users/cy/Documents/03 life/AI design/产品项目/design harness/slock/Design Harness v1/SLOCK_DESIGN_HARNESS.md
  - /Users/cy/Documents/03 life/AI design/产品项目/design harness/KAMI/KAMI_DESIGN_HARNESS.md
---

# Clowder Visual Themes Design

## 1. Design Decision

Clowder now supports four visual directions through one token layer:

- `claude`: warm, restrained, focused, information-first. This is the default.
- `slack`: collaboration-first, darker left rail, stronger channel identity.
- `slockv1`: Slock Design Harness v1, yellow rail, cream sidebar, pink active states, black borders, hard shadows.
- `kami`: KAMI Design Harness, parchment surfaces, editorial hierarchy, ink-blue accent, quiet ring/shadow depth.

The key decision is not to merge these styles into one mixed language. Slock v1
is intentionally louder than Claude and Slack: it uses visible frames, hard
shadows, square controls, and high-contrast rail/tab states to clarify ownership
and operating context. KAMI moves in the opposite direction: it makes Clowder
feel like a calm reading/editorial workspace, with parchment warmth, serif-led
rhythm where possible, restrained borders, and a single ink-blue accent.

## 2. Theme Switch Model

Theme switching is controlled by:

```text
document.documentElement.dataset.visualTheme = "claude" | "slack" | "slockv1" | "kami"
localStorage["clowder:visual-theme"]
```

The left Activity Bar cycles through `C -> S -> V1 -> K -> C`.

This visual theme is independent from the existing light/dark theme. The
visual theme changes product language; light/dark changes luminance mode.

Dark mode must be implemented as a combination selector:

```css
[data-theme="dark"][data-visual-theme="slack"]
[data-theme="dark"][data-visual-theme="slockv1"]
[data-theme="dark"][data-visual-theme="kami"]
```

Do not rely on the default dark tokens alone. Otherwise switching to dark mode
will erase the visual theme's accent and surface rules.

## 3. Claude Theme

Claude is the default Clowder language.

- Background: warm cream, not pure white.
- Accent: restrained coral.
- Sidebar: quiet warm panel, active state via a 2px accent line.
- Typography: 14px body, 13px sender, 12px meta, 11px section labels.
- Goal: calm, restrained, focused, medium density, information-first.

Use it when Clowder is being treated as an AI workbench rather than a consumer
messaging app.

## 4. Slack Theme

Slack mode gives Clowder a stronger collaboration feel.

- Rail/sidebar: deep aubergine.
- Main content: white.
- Accent: Slack-like blue.
- Section labels: slightly larger and bolder than Claude.
- Goal: make channels, DMs, and collaboration state feel more explicit.

Slack mode should not force every component into purple. The purple belongs to
the navigation shell; the conversation content should stay readable and clean.

## 5. Slock v1 Theme

Slock v1 follows the local Slock Design Harness v1.

- Rail: yellow `#FFD440`.
- Sidebar: warm cream `#FFFAEF`.
- Text and borders: ink `#141111`.
- Active state: pink `#FE7DA8`.
- Cards and panels: black borders plus hard offset shadows.
- Tabs: active yellow, inactive white.
- Status colors: orange, cyan, purple, green, gray.

Slock v1 keeps Clowder's existing information architecture, but makes the
operating surface more explicit: rail, sidebar, tabs, message hover frames, task
cards, and modal surfaces should all read as part of one neo-brutalist system.

## 6. KAMI Theme

KAMI follows the local KAMI Design Harness and adapts it to Clowder's app shell.

- Background: parchment `#F5F4ED`, never pure white.
- Elevated surfaces: ivory `#FAF9F5`.
- Accent: ink blue `#1B365D`, with `#2D5A8A` hover.
- Text: warm near-black `#141413`, not cold slate.
- Tags/chips: solid blue-gray papers, not transparent washes.
- Depth: quiet ring/whisper shadows, not hard offset shadows.
- Goal: make Clowder feel like a composed reading and coordination desk.

KAMI should not become a general blue dashboard. The blue is a signature mark
for active states, controls, and inline chips. The dominant impression should
remain parchment, ink, editorial hierarchy, and low visual noise.

## 7. Message Hover Rule

The message hover frame is intentionally shared across themes because the user
explicitly accepted this Slock-like behavior.

Rule:

- The hover frame wraps the whole message unit: avatar, content, and action
  buttons.
- The action toolbar appears inside the top-right of the frame.
- Do not add a second inner ring around the content bubble.

This interaction answers "which whole message am I operating on?" and should
not be changed by visual themes unless a future explicit design decision
replaces the shared interaction model.

## 8. Implementation Map

- `packages/web/src/components/ActivityBar.tsx`
  - Stores and cycles the visual theme.
  - Writes `data-visual-theme` to the root element.

- `packages/web/src/app/theme-tokens.css`
  - Defines the product-level color and type tokens.
  - Contains `claude`, `slack`, `slockv1`, and `kami` visual theme overrides.
  - Contains dark-mode combination overrides for Slack, Slock v1, and KAMI.
  - Owns markdown chip tokens:
    `--clowder-markdown-chip-bg`, `--clowder-markdown-chip-border`,
    `--clowder-markdown-chip-text`, and `--clowder-section-title-bg`.
  - Owns sender name tokens:
    `--clowder-sender-user` and `--clowder-sender-agent`. These must follow
    `--cafe-text`, not avatar or identity colors.

- `packages/web/src/app/console-shell.css`
  - Defines shell/page/component-level surface tokens.
  - Contains matching visual theme overrides for rail, cards, fields, and
    modal surfaces.
  - Contains dark-mode combination overrides for Slack, Slock v1, and KAMI shell colors.

- `packages/web/src/components/MessageActions.tsx`
  - Owns the accepted Slock-style message hover frame.

- `packages/web/src/components/MarkdownContent.tsx`
  - Uses markdown chip tokens for inline code and section highlights.
  - Must not hardcode Claude-only peach colors, otherwise Slack/Slock v1/KAMI themes
    drift out of spec.

## 9. Acceptance Criteria

- Clicking the Activity Bar visual switch cycles `C -> S -> V1 -> K`.
- `V1` mode shows a yellow rail, cream sidebar, black frames, pink active states, and hard shadows.
- `K` mode shows parchment surfaces, ivory cards, warm ink text, ink-blue active states, and quiet shadows.
- `S` mode keeps deep purple navigation and white main content.
- `C` mode remains the warm, restrained default.
- Inline code chips follow the active visual theme instead of staying peach.
- Sender names use the theme's primary text color, so they remain readable on
  both light and dark backgrounds.
- Dark mode keeps each visual theme's accent and surface language.
- The accepted message hover frame remains unchanged in all four themes.
