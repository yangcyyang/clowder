import { fileURLToPath } from 'node:url';
import { rebuildPersonalSkillIndexFromEnv } from '../config/skills/personal-skill-scanner.js';

export async function runRebuildPersonalSkillsCli(): Promise<void> {
  const result = await rebuildPersonalSkillIndexFromEnv(process.cwd(), process.env);
  console.log(
    `total=${result.total} visible=${result.visible} duplicates=${result.duplicates} ignoredHiddenDirs=${result.ignoredHiddenDirs}`,
  );
}

const entryPath = process.argv[1];
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  runRebuildPersonalSkillsCli().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
