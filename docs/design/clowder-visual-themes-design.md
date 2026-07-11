---
doc_kind: design
created: 2026-05-18
feature_ids: []
source:
  - awesome-claude-design/design-md/claude.DESIGN.md
  - awesome-claude-design/design-md/slack.DESIGN.md
  - ~/Documents/03 life/AI design/产品项目/design harness/slock/Design Harness v1/SLOCK_DESIGN_HARNESS.md
  - ~/Documents/03 life/AI design/产品项目/design harness/slock/Design Harness v2/SLOCK_DESIGN_HARNESS.md
  - ~/Documents/03 life/AI design/产品项目/design harness/slock/Design Harness v2/SLOCK_TOKEN_LOCK.md
  - ~/Documents/03 life/AI design/产品项目/design harness/KAMI/KAMI_DESIGN_HARNESS.md
---

# Clowder Visual Themes Design

## 1. Design Decision

Clowder now supports five visual directions through one token layer:

- `claude`: warm, restrained, focused, information-first. This is the default.
- `slack`: collaboration-first, darker left rail, stronger channel identity.
- `slockv1`: Slock Design Harness v1, yellow rail, cream sidebar, pink active states, black borders, hard shadows.
- `slock`: Slock Design Harness v2, current default productized neo-brutalist operating workspace.
- `kami`: KAMI Design Harness, parchment surfaces, editorial hierarchy, ink-blue accent, quiet ring/shadow depth.

The key decision is not to merge these styles into one mixed language. Slock v1
keeps the first extracted harness language, while the default `slock` theme is
the current v2 productized neo-brutalist shell. KAMI is added as a separate
quiet editorial option. They can coexist as theme options, but should not be
blended inside one theme.

## 2. Theme Switch Model

Theme switching is controlled by:

```text
document.documentElement.dataset.visualTheme = "claude" | "slack" | "slockv1" | "slock" | "kami"
localStorage["clowder:visual-theme"]
```

The left Activity Bar cycles through `C -> S -> V1 -> SL -> K -> C`.

This visual theme is independent from the existing light/dark theme. The
visual theme changes product language; light/dark changes luminance mode.

Dark mode must be implemented as a combination selector:

```css
[data-theme="dark"][data-visual-theme="claude"]
[data-theme="dark"][data-visual-theme="slack"]
[data-theme="dark"][data-visual-theme="slockv1"]
[data-theme="dark"][data-visual-theme="slock"]
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

## 6. Slock v2 Theme

Slock v2 is the current default product theme and follows the local Slock
Design Harness v2.

- Rail: `#FFD83D`, width `52px`, right divider `3px solid #000`.
- Workspace sidebar: `#FFF9EC`, baseline width `260px`.
- Main canvas: `#FFFFFF`, hard black borders, no soft gray SaaS dividers.
- Hover/chip/code: `#FFF0A6`.
- Active state: `#F46FA7`, with black text.
- Radius: main Slock controls use `0`.
- Shadows: hard offset only, `6px`, `4px`, `3px`, or `2px`; no blur shadows.
- Composer: min height `112px`, treated as a workbench input panel.

Slock v2 is token locked. Implementation must preserve the named `--slock-*`
aliases in addition to existing Clowder semantic tokens, so future projects can
reuse the theme without scraping component CSS.

## 7. KAMI Theme

KAMI follows the local KAMI Design Harness and adapts it to Clowder's app shell.

- Background: parchment `#F5F4ED`, never pure white.
- Elevated surfaces: ivory `#FAF9F5`.
- Accent: ink blue `#1B365D`, with `#2D5A8A` hover.
- Text: warm near-black `#141413`, not cold slate.
- Tags/chips: solid blue-gray papers, not transparent washes.
- Depth: quiet ring/whisper shadows, not hard offset shadows.
- Goal: make Clowder feel like a composed reading and coordination desk.

KAMI should not override the default `slock` language. It is an additional
theme selected through `data-visual-theme="kami"`.

## 8. Message Hover Rule

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

## 9. Implementation Map

- `packages/web/src/components/ActivityBar.tsx`
  - Stores and cycles the visual theme.
  - Writes `data-visual-theme` to the root element.
  - Uses `--slock-rail-width` for the v2 activity rail.

- `packages/web/src/app/theme-tokens.css`
  - Defines the product-level color and type tokens.
  - Contains `claude`, `slack`, `slockv1`, `slock`, and `kami` visual theme overrides.
  - Contains dark-mode combination overrides for Claude, Slack, Slock v1, Slock, and KAMI.
  - Owns the Slock v2 token lock aliases:
    `--slock-ink`, `--slock-rail-yellow`, `--slock-cream`,
    `--slock-warm-yellow`, `--slock-pink-active`, `--slock-border-width`,
    `--slock-rail-border-width`, and the four hard shadow tokens.
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
  - Contains dark-mode combination overrides for Claude, Slack, Slock v1, Slock, and KAMI shell colors.
  - Owns Slock v2 hard-frame selectors for activity rail, composer, page frames,
    cards, chips, search fields, and icon controls.

- `packages/web/src/components/ChatInput.tsx`
  - Marks the composer and its controls with Slock v2 frame/control classes.

- `packages/web/src/components/MessageActions.tsx`
  - Owns the accepted Slock-style message hover frame.

- `packages/web/src/components/MarkdownContent.tsx`
  - Uses markdown chip tokens for inline code and section highlights.
  - Must not hardcode Claude-only peach colors, otherwise Slack/Slock v1/Slock/KAMI themes
    drift out of spec.

## 10. Acceptance Criteria

- Clicking the Activity Bar visual switch cycles `C -> S -> V1 -> SL -> K`.
- `V1` mode shows a yellow rail, cream sidebar, black frames, pink active states, and hard shadows.
- `SL` mode follows Slock v2 token lock: yellow rail, cream sidebar, 0 radius,
  2px black borders, hard offset shadows, 112px composer.
- `K` mode shows parchment surfaces, ivory cards, warm ink text, ink-blue active states, and quiet shadows.
- `S` mode keeps deep purple navigation and white main content.
- `C` mode remains the warm, restrained default.
- Inline code chips follow the active visual theme instead of staying peach.
- Sender names use the theme's primary text color, so they remain readable on
  both light and dark backgrounds.
- Dark mode keeps each visual theme's accent and surface language.
- The accepted message hover frame remains unchanged in all five themes.
