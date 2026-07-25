/**
 * F-F（批次 3，PRD-memory-upgrade.md）：猫主动写记忆工具。
 *
 * 复用 evidence-tools.ts/callback-memory-tools.ts 已验证的 callback 调用模式
 * （callbackPost 走 invocation-scoped 鉴权，callback-tools.ts 已导出）——写记
 * 忆需要知道"是哪只猫在写"，callback 鉴权（X-Invocation-Id/X-Callback-Token）
 * 天然携带 catId，这也是选 callback 而不是公开路由（像 evidence 搜索那样）的
 * 原因。
 *
 * 这个工具**不做判定**，只把 (content, type?, why?) 转发到
 * POST /api/callbacks/write-memory；真正的晋级判定（promote/candidate/hold/
 * skip）全部在 API 侧的 evaluateAndRouteMemoryWrite 完成——与
 * AgentMemoryAutoWriter.autoUpdateAgentMemory 共享同一个 evaluateMemoryPromotion
 * 判定函数（AgentMemoryPromotionGate.ts），不重新实现或绕过。
 */
import { z } from 'zod';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

export const writeMemoryInputSchema = {
  content: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe('要沉淀的记忆内容——一句蒸馏后的结论/偏好/事实，不是原始对话粘贴或大段细节'),
  type: z
    .enum(['user', 'feedback', 'project', 'reference'])
    .optional()
    .describe(
      '分类（可选）：user=铲屎官本人的偏好/硬约束/账号级事实；' +
        'feedback=被纠正的行为偏好或错误（强烈建议配 why）；' +
        'project=项目级事实（进度/决策/约定）；reference=参考资料/踩坑记录',
    ),
  why: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .optional()
    .describe('为什么要记住这条——type=feedback 时强烈建议填写，否则以后重读不知道这条规则的动机'),
};

export async function handleWriteMemory(input: {
  content: string;
  type?: 'user' | 'feedback' | 'project' | 'reference' | undefined;
  why?: string | undefined;
}): Promise<ToolResult> {
  return callbackPost('/api/callbacks/write-memory', {
    content: input.content,
    ...(input.type ? { type: input.type } : {}),
    ...(input.why ? { why: input.why } : {}),
  });
}

export const writeMemoryTools = [
  {
    name: 'cat_cafe_write_memory',
    description:
      'Proactively persist a memory item DURING conversation — for when you discover something worth remembering ' +
      'right now (a stated preference, a correction, a project fact, a gotcha), instead of only relying on the ' +
      'automatic end-of-turn memory writeback. USE WHEN: 铲屎官 states a preference/hard-constraint/account-level ' +
      'fact (type=user); you get corrected on a behavior and need to remember why (type=feedback, why STRONGLY ' +
      'recommended); you learn a project-level fact/decision worth persisting across sessions (type=project); you ' +
      'hit a gotcha or reference detail worth a quick note (type=reference). ' +
      'DO NOT use for session-only scratch state, or content already recorded in memory/docs. ' +
      'IMPORTANT — same gate as automatic writeback: this tool goes through the identical promotion review used by ' +
      'the automatic memory writeback, it never bypasses review. The gate returns one of: written (durable memory ' +
      'updated immediately), queued/held (sent to the human-review candidate queue — often because it looks similar ' +
      'to, or conflicts with, existing memory; the response may include a merge/supersede suggestion), or skipped ' +
      '(dropped — e.g. exact duplicate, session-only content, or an unsourced low-confidence guess). ' +
      'A "held"/"skipped" result is NOT a tool failure — it is the gate working as intended; the response always ' +
      'reports which outcome happened and why, so read the `status`/`reason` fields rather than treating any ' +
      'non-"written" result as an error.',
    inputSchema: writeMemoryInputSchema,
    handler: handleWriteMemory,
  },
] as const;
