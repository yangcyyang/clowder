import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chatContainerSource = readFileSync(resolve(process.cwd(), 'src/components/ChatContainer.tsx'), 'utf8');
const consoleShellCss = readFileSync(resolve(process.cwd(), 'src/app/console-shell.css'), 'utf8');

describe('Raft channel tab contract', () => {
  it('keeps exactly three icon-labelled tabs inside one segmented control', () => {
    const channelTabs = chatContainerSource.slice(
      chatContainerSource.indexOf('function ChannelTabs'),
      chatContainerSource.indexOf('export function ChatContainer'),
    );

    expect(channelTabs.match(/id: '(chat|tasks|files)'/g)).toHaveLength(3);
    expect(channelTabs).toContain('slock-channel-tabs-row flex h-7');
    expect(channelTabs).not.toContain('slock-channel-tabs-row flex h-8');
    expect(channelTabs).toContain('slock-tab-segmented');
    expect(channelTabs).toContain('slock-tab-icon');
    expect(channelTabs).not.toContain('slock-tab-empty');
  });

  it('uses one outer border, internal dividers, and a yellow active segment', () => {
    expect(consoleShellCss).toMatch(/\.slock-tab-segmented\s*{[\s\S]*?border:/);
    expect(consoleShellCss).toMatch(/\.slock-tab-button\s*{[\s\S]*?border-right:/);
    expect(consoleShellCss).toMatch(/\.slock-tab-button:last-child\s*{[\s\S]*?border-right:\s*0/);
    const activeRule = consoleShellCss.match(/\.slock-tab-button\[data-active="true"\]\s*{[\s\S]*?}/)?.[0];
    expect(activeRule).toContain('background: var(--slock-rail-yellow)');
    expect(activeRule).not.toContain('color-mix');
  });

  it('lets responsive visibility utilities override the shared header-action display', () => {
    expect(consoleShellCss).toContain(':where(.slock-header-action) {');
    expect(consoleShellCss).not.toMatch(/\n\.slock-header-action\s*{[\s\S]*?display:\s*inline-flex/);
  });
});
