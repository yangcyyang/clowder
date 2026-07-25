import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AVATAR_PRESETS } from '@/components/hub-cat-editor.sections';

const testDir = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(testDir, '..', '..', '..', 'public');

// clowder-ai batch-3G: 铲屎官反馈"成员配置/预览与编辑"弹窗里预设头像区上面两行像素方块脸
// (原 `/avatars/slock/*`，16 个) 该去掉，只保留下面的猫咪插画头像。
// 这里只从可选清单里移除像素组，不删资产文件——已经在用某个像素头像的存量猫，
// 其头像 URL 必须继续可渲染（见 hub-cat-editor.test.tsx 的
// "does not offer pixel-block presets, but keeps legacy pixel avatars renderable" 用例）。
describe('AVATAR_PRESETS (hub-cat-editor.sections)', () => {
  it('does not include the pixel-block preset group', () => {
    const pixelEntries = AVATAR_PRESETS.filter(
      (preset) => /slock/i.test(preset.label) || preset.src.includes('/avatars/slock/'),
    );
    expect(pixelEntries).toEqual([]);
  });

  it('keeps the cat-illustration preset group intact', () => {
    expect(AVATAR_PRESETS.length).toBe(20);
    const labels = AVATAR_PRESETS.map((preset) => preset.label);
    expect(labels).toEqual(
      expect.arrayContaining(['Default', 'Opus', 'Sonnet', 'Codex', 'Gemini', 'Kimi', 'Antigravity', 'Dare']),
    );
  });

  it('leaves the removed pixel-block asset files on disk (list-only removal, not a deletion)', () => {
    // A sample of the 16 removed entries — asset files must still exist so any existing
    // cat whose `avatar` still points here keeps rendering, even though the preset picker
    // no longer offers them.
    const sampleAssets = [
      'slock/slock-blue-cat.png',
      'slock/slock-yellow-cat.png',
      'slock/slock-skull.png',
      'slock/slock-yellow-crown.png',
    ];
    for (const asset of sampleAssets) {
      expect(existsSync(resolve(publicDir, 'avatars', asset))).toBe(true);
    }
  });
});
