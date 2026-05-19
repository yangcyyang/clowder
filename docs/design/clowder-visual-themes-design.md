---
doc_kind: design
created: 2026-05-18
feature_ids: []
source:
  - awesome-claude-design/design-md/claude.DESIGN.md
  - awesome-claude-design/design-md/slack.DESIGN.md
  - awesome-claude-design/design-md/tesla.DESIGN.md
---

# Clowder Visual Themes Design

## 1. Design Decision

Clowder now supports three visual directions through one token layer:

- `claude`: warm, restrained, focused, information-first. This is the default.
- `slack`: collaboration-first, darker left rail, stronger channel identity.
- `tesla`: radical subtraction, white canvas, single blue accent, minimal chrome.

The key decision is not to merge these styles into one mixed language. Tesla and
the Slock-like screenshot solve different problems. Tesla is quiet and flat;
Slock's hover state uses a visible line frame to clarify message ownership. They
can coexist as theme options, but should not be blended inside one theme.

## 2. Theme Switch Model

Theme switching is controlled by:

```text
document.documentElement.dataset.visualTheme = "claude" | "slack" | "tesla"
localStorage["clowder:visual-theme"]
```

The left Activity Bar cycles through `C -> S -> T -> C`.

This visual theme is independent from the existing light/dark theme. The
visual theme changes product language; light/dark changes luminance mode.

Dark mode must be implemented as a combination selector:

```css
[data-theme="dark"][data-visual-theme="slack"]
[data-theme="dark"][data-visual-theme="tesla"]
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

## 5. Tesla Theme

Tesla mode follows radical subtraction.

- Canvas: pure white.
- Text: carbon `#171A20`, graphite `#393C41`, pewter `#5C5E62`.
- Accent: single electric blue `#3E6AE1`.
- Surfaces: flat white or light ash `#F4F4F4`.
- Shadows: none.
- Borders: only subtle `#EEEEEE` or `#D0D1D2` dividers.
- Decoration: none unless it communicates state.

Tesla mode is not a car website replica. Clowder has dense chat and task data,
so it keeps the existing information architecture and only applies the Tesla
principles at the token level: fewer colors, flatter surfaces, weaker chrome,
and a single blue action color.

## 6. Message Hover Rule

The message hover frame is intentionally shared across themes because the user
explicitly accepted this Slock-like behavior.

Rule:

- The hover frame wraps the whole message unit: avatar, content, and action
  buttons.
- The action toolbar appears inside the top-right of the frame.
- Do not add a second inner ring around the content bubble.

This interaction answers "which whole message am I operating on?" and should
not be changed by visual themes unless a future explicit design decision
replaces the Slock interaction model.

## 7. Implementation Map

- `packages/web/src/components/ActivityBar.tsx`
  - Stores and cycles the visual theme.
  - Writes `data-visual-theme` to the root element.

- `packages/web/src/app/theme-tokens.css`
  - Defines the product-level color and type tokens.
  - Contains `claude`, `slack`, and `tesla` visual theme overrides.
  - Contains dark-mode combination overrides for Slack and Tesla.
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
  - Contains dark-mode combination overrides for Slack and Tesla shell colors.

- `packages/web/src/components/MessageActions.tsx`
  - Owns the accepted Slock-style message hover frame.

- `packages/web/src/components/MarkdownContent.tsx`
  - Uses markdown chip tokens for inline code and section highlights.
  - Must not hardcode Claude-only peach colors, otherwise Slack/Tesla themes
    drift out of spec.

## 8. Acceptance Criteria

- Clicking the Activity Bar visual switch cycles `C -> S -> T`.
- `T` mode shows a white shell, flat cards, weak dividers, and blue accents.
- `S` mode keeps deep purple navigation and white main content.
- `C` mode remains the warm, restrained default.
- Inline code chips follow the active visual theme instead of staying peach.
- Sender names use the theme's primary text color, so they remain readable on
  both light and dark backgrounds.
- Dark mode keeps each visual theme's accent and surface language.
- The accepted message hover frame remains unchanged in all three themes.
