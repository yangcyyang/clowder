# Task #393 恢复界面语义色回归

## Bug 诊断胶囊

| 栏位 | 内容 |
|------|------|
| **1. 现象** | GitHub Actions 的 `Web Vitest (Required)` 失败；期望 F056 颜色审计通过，实际检出恢复界面中的 10 个 `slate-*` Tailwind 工具类。 |
| **2. 证据** | run `29644133508` 中仅 `src/components/__tests__/f056-color-audit.test.ts` 失败；本地在提交 `5a10357` 稳定复现为 1/2 测试失败，命中 `global-error.tsx` 7 处、`ChunkLoadRefreshGuard.tsx` 3 处。 |
| **3. 问题假设或根因** | 根因已确认：Task #393 新增界面直接使用 slate/white/black 视觉色，而仓库 F056 要求组件使用主题语义 token；聚焦恢复测试未覆盖全仓颜色审计，因此本地门禁漏报。 |
| **4. 诊断策略** | 对照既有 `ConfirmDialog` 等模态框，复用 `--console-overlay-backdrop`、`cafe-surface`、`cafe-text*`、`cafe-border` 和 `cafe-accent*` 语义 token；不改变恢复控制流。 |
| **5. 超时策略** | 若最小语义类替换后 F056 仍失败，停止扩改并核对扫描器规则及 Tailwind token 映射。 |
| **6. 预警策略** | 若聚焦组件测试或生产构建出现行为/样式类回归，回滚该最小补丁并重新分析；不叠加第三处代码改动。 |
| **7. 用户可见交互修正** | 恢复提示和全局错误页将跟随当前 Clowder 主题，文案、按钮动作和恢复策略不变。 |
| **8. 验收** | F056 2/2、恢复 Guard/global-error 聚焦测试、lint、Biome、diff-check、production build 通过，并由新一轮 GitHub Actions 11 jobs 验证。 |

## 五件套

1. **报告人**：GitHub Actions 在 Task #393 首轮合并后 CI 中发现。
2. **复现步骤**：在仓库根目录运行 `pnpm --dir packages/web exec vitest run src/components/__tests__/f056-color-audit.test.ts`。
3. **根因分析**：恢复功能本身测试通过，但新增视觉类绕过了主题语义色约束；全量 Required 套件才执行 F056 审计。
4. **修复方案**：仅将两个恢复界面的硬编码色替换为仓库既有语义 token，避免新增 token 或改变交互逻辑。
5. **验证方式**：先保留上述红测证据，修复后重跑 F056 与 Task #393 聚焦门禁，再以完整 GitHub Actions 收口。

## Quality Gate Report

- **愿景覆盖**：继续满足“旧标签页自动恢复、草稿存在时不自动刷新”；本补丁只让恢复 UI 跟随主题，不改变恢复控制器。
- **交付完整性**：这是 CI 发现的单一合规回归修复，不引入新的分批交付或待重写部分。
- **设计稿对照**：仓库无 `designs/` 目录，也无与 Task #393/recovery/chunk 匹配的 `.pen`；本次复用现有模态框语义 token。
- **close/fallback 检查**：本补丁没有 unmet AC 或新增 fallback；仓库未提供 `check-hotfix-pattern.mjs` / `check-fallback-layers.mjs`，相关脚本门禁不可执行。
- **完整 Web 门禁**：blocking 412 files / 2969 tests；quarantine 精确基线 15 files / 122 tests / 37 failures；config 13/13；native 17/17；recovery 7/7；color plugin 通过。
- **聚焦回归**：F056 + Guard + global-error 共 3 files / 19 tests 全绿。
- **静态与构建**：Web lint 0 errors（仅既有 warnings）；目标 Biome 2 files；`git diff --check`；production build `task393-color-gate` 均通过。
- **Artifact Hygiene**：工作树与已提交差异均无仓库根目录媒体/设计工件。
