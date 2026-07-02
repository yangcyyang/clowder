#!/usr/bin/env node
// 主题 token 完整性校验：每个 visual theme（明/暗）必须覆盖同一组核心语义 token。
// 背景：主题各自手维护 token 块，漏配某个 token 时会静默回退到 :root 默认值，
// 造成"某主题某处颜色不对"的隐性视觉 bug（例：早期 slock 暗色整块缺失）。
// 契约清单 = 生成时四主题已定义 token 的交集；新增主题或新增核心 token 时同步更新此清单。

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TOKEN_FILES = ['packages/web/src/app/theme-tokens.css', 'packages/web/src/app/console-shell.css'];

const THEMES = ['claude', 'slockv1', 'slock', 'kami'];

// 每个主题亮色块必须定义的核心 token
const CONTRACT_LIGHT = [
  '--cat-cream-white',
  '--cat-light-sand',
  '--cat-border-tan',
  '--cat-deep-ink',
  '--cat-muted-stone',
  '--cat-paw-pink',
  '--cafe-surface',
  '--cafe-surface-elevated',
  '--cafe-surface-sunken',
  '--cafe-text',
  '--cafe-text-secondary',
  '--cafe-text-muted',
  '--cafe-border',
  '--cafe-border-subtle',
  '--cafe-accent',
  '--cafe-accent-hover',
  '--cafe-accent-foreground',
  '--cafe-interactive',
  '--color-cafe-accent',
  '--bg-app',
  '--text-primary',
  '--text-secondary',
  '--clowder-sidebar-bg',
  '--clowder-sidebar-border',
  '--clowder-sidebar-title',
  '--clowder-sidebar-row-text',
  '--clowder-sidebar-row-active-text',
  '--clowder-sidebar-row-muted',
  '--clowder-sidebar-active-bg',
  '--clowder-sidebar-active-border',
  '--clowder-sidebar-hover-bg',
  '--clowder-section-tracking',
  '--clowder-message-hover-ring',
  '--clowder-markdown-chip-bg',
  '--clowder-markdown-chip-border',
  '--clowder-markdown-chip-text',
  '--clowder-section-title-bg',
  '--clowder-sender-user',
  '--clowder-sender-agent',
  '--clowder-muted-soft',
  '--clowder-avatar-quiet-ring',
  '--console-shell-bg',
  '--console-panel-bg',
  '--console-card-bg',
  '--console-card-soft-bg',
  '--console-code-bg',
  '--console-pill-bg',
  '--console-border-soft',
  '--console-border-strong',
  '--console-shadow',
  '--console-shadow-soft',
  '--console-field-bg',
  '--console-active-bg',
  '--console-hover-bg',
  '--console-rail-bg',
  '--console-rail-item',
  '--console-rail-active',
  '--console-rail-fg',
  '--console-input-stroke',
  '--console-button-emphasis',
  '--console-button-emphasis-hover',
  '--console-modal-title',
  '--console-modal-close-bg',
  '--console-modal-close-fg',
  '--console-cat-fallback',
  '--console-status-connected',
  '--chat-code-bg',
  '--chat-code-text',
  '--chat-code-btn-bg',
  '--chat-code-btn-text',
  '--chat-code-border',
];

// 暗色契约 = 亮色契约去掉仅亮色需要的三个（与现状一致：sender/section-tracking 暗色走默认）
const CONTRACT_DARK = CONTRACT_LIGHT.filter(
  (t) => !['--clowder-section-tracking', '--clowder-sender-user', '--clowder-sender-agent'].includes(t),
);

// slock 家族（slock + slockv1 亮色）共享组件规则消费的调色板别名，
// 见 console-shell.css 中的 :is([data-visual-theme="slock"], [data-visual-theme="slockv1"]...) 规则
const SLOCK_FAMILY = ['slock', 'slockv1'];
const SLOCK_FAMILY_LIGHT = [
  '--slock-ink',
  '--slock-rail-yellow',
  '--slock-cream',
  '--slock-warm-yellow',
  '--slock-pink-active',
  '--slock-pink-hover',
  '--slock-white',
  '--slock-muted-text',
  '--slock-secondary-text',
  '--slock-success',
];

function parseBlocks(css) {
  const blocks = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m = re.exec(stripped);
  while (m) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const tokens = [...m[2].matchAll(/(--[\w-]+)\s*:/g)].map((t) => t[1]);
    if (tokens.length) blocks.push({ selector, tokens });
    m = re.exec(stripped);
  }
  return blocks;
}

const defined = {
  light: Object.fromEntries(THEMES.map((t) => [t, new Set()])),
  dark: Object.fromEntries(THEMES.map((t) => [t, new Set()])),
};

for (const file of TOKEN_FILES) {
  const css = readFileSync(resolve(projectRoot, file), 'utf8');
  for (const block of parseBlocks(css)) {
    for (const theme of THEMES) {
      if (block.selector === `[data-visual-theme="${theme}"]`) {
        for (const token of block.tokens) defined.light[theme].add(token);
      }
      if (block.selector === `[data-theme="dark"][data-visual-theme="${theme}"]`) {
        for (const token of block.tokens) defined.dark[theme].add(token);
      }
    }
  }
}

let failures = 0;

function check(theme, mode, contract, definedSet) {
  const missing = contract.filter((token) => !definedSet.has(token));
  if (missing.length === 0) {
    console.log(`✓ ${theme} (${mode}) 覆盖完整 (${contract.length} tokens)`);
    return;
  }
  failures += missing.length;
  console.error(`✗ ${theme} (${mode}) 缺失 ${missing.length} 个 token:`);
  for (const token of missing) console.error(`    ${token}`);
}

for (const theme of THEMES) {
  check(theme, 'light', CONTRACT_LIGHT, defined.light[theme]);
  check(theme, 'dark', CONTRACT_DARK, defined.dark[theme]);
}

for (const theme of SLOCK_FAMILY) {
  check(theme, 'light/slock-family-palette', SLOCK_FAMILY_LIGHT, defined.light[theme]);
}

if (failures > 0) {
  console.error(
    `\n共 ${failures} 处缺失。每个主题必须在 theme-tokens.css / console-shell.css 中覆盖契约内的全部 token。`,
  );
  process.exit(1);
}
console.log('\n主题 token 完整性校验通过。');
