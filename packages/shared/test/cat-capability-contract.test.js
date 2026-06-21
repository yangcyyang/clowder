import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { canCatHandleTask } = await import('../dist/utils/cat-capability-contract.js');

describe('canCatHandleTask', () => {
  it('allows cats without a capability contract for backward compatibility', () => {
    assert.equal(canCatHandleTask({}, '修复 Clowder 前端 bug'), true);
  });

  it('matches primary roles, capabilities and handoff triggers', () => {
    const cat = {
      capabilityContract: {
        primaryRoles: ['工程执行'],
        canHandle: ['修复', '测试'],
        handoffTriggers: ['代码实现'],
      },
    };

    assert.equal(canCatHandleTask(cat, { title: '代码实现：修复消息排版' }), true);
    assert.equal(canCatHandleTask(cat, { title: '整理人生规划' }), false);
  });

  it('lets shouldAvoid terms override positive matches', () => {
    const cat = {
      capabilityContract: {
        primaryRoles: ['工程执行'],
        canHandle: ['修复'],
        shouldAvoid: ['最终验收'],
      },
    };

    assert.equal(canCatHandleTask(cat, '修复完成后做最终验收'), false);
  });
});
