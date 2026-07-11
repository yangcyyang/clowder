/**
 * Callback Limb Routes — F126 四肢控制面 MCP 回调端点
 *
 * POST /api/callback/limb/list  — 列出可用四肢节点
 * POST /api/callback/limb/invoke — 调用四肢节点能力
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FreshnessEgressGate } from '../domains/cats/services/agents/freshness/FreshnessEgressGate.js';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { LimbPairingStore } from '../domains/limb/LimbPairingStore.js';
import type { LimbRegistry } from '../domains/limb/LimbRegistry.js';
import { RemoteLimbNode } from '../domains/limb/RemoteLimbNode.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { claimCallbackSideEffect } from './callback-freshness-side-effect.js';

const limbListSchema = z.object({
  capability: z.string().optional(),
});

const limbInvokeSchema = z.object({
  nodeId: z.string().min(1),
  command: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});

const limbPairApproveSchema = z.object({
  requestId: z.string().min(1),
});

export interface CallbackLimbRoutesOptions {
  limbRegistry: LimbRegistry;
  pairingStore?: LimbPairingStore;
  freshnessGate?: FreshnessEgressGate;
  registry: Pick<InvocationRegistry, 'isLatest'>;
}

export function registerCallbackLimbRoutes(
  app: FastifyInstance,
  { limbRegistry, pairingStore, freshnessGate, registry }: CallbackLimbRoutesOptions,
): void {
  app.post('/api/callback/limb/list', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbListSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { capability } = parsed.data;

    const nodes = capability ? limbRegistry.findByCapability(capability) : limbRegistry.listAvailable();

    return reply.send({
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        displayName: n.displayName,
        platform: n.platform,
        capabilities: n.capabilities,
        status: n.status,
      })),
    });
  });

  app.post('/api/callback/limb/invoke', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const parsed = limbInvokeSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

    const { nodeId, command, params } = parsed.data;

    if (!limbRegistry.getNode(nodeId)) {
      return reply.send(
        await limbRegistry.invoke(nodeId, command, params ?? {}, {
          catId: record.catId,
          invocationId: record.invocationId,
        }),
      );
    }
    const freshness = await claimCallbackSideEffect({
      freshnessGate,
      registry,
      record,
      route: 'limb-invoke',
      requestBody: parsed.data,
    });
    if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return reply.send(freshness.response);

    const result = await limbRegistry.invoke(nodeId, command, params ?? {}, {
      catId: record.catId,
      invocationId: record.invocationId,
    });
    return reply.send(result);
  });

  // Phase C: Pairing callback routes (for MCP tools)
  if (pairingStore) {
    app.post('/api/callback/limb/pair/list', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      return reply.send({ requests: pairingStore.getPending() });
    });

    app.post('/api/callback/limb/pair/approve', async (request, reply) => {
      const record = requireCallbackAuth(request, reply);
      if (!record) return;

      const parsed = limbPairApproveSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });

      const pending = pairingStore.getPending().find((entry) => entry.requestId === parsed.data.requestId);
      if (!pending) return reply.status(404).send({ error: 'Pairing request not found' });
      const freshness = await claimCallbackSideEffect({
        freshnessGate,
        registry,
        record,
        route: 'limb-pair-approve',
        requestBody: parsed.data,
      });
      if (freshness.outcome === 'stale' || freshness.outcome === 'replayed') return reply.send(freshness.response);

      const req = pairingStore.approve(parsed.data.requestId);
      if (!req) return reply.status(409).send({ error: 'Pairing request is no longer pending' });

      // Register RemoteLimbNode if not already registered
      if (!limbRegistry.getNode(req.nodeId)) {
        const remoteNode = new RemoteLimbNode({
          nodeId: req.nodeId,
          displayName: req.displayName,
          platform: req.platform,
          capabilities: req.capabilities,
          endpointUrl: req.endpointUrl,
          apiKey: req.apiKey,
        });
        await limbRegistry.register(remoteNode);
      }

      return reply.send({ status: 'approved', nodeId: req.nodeId });
    });
  }
}
