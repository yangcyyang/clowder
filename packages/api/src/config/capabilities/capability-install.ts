import type { CapabilityEntry, McpInstallPreview, McpInstallRequest } from '@cat-cafe/shared';
import { MARKETPLACE_ECOSYSTEMS } from '@cat-cafe/shared';

const CLI_CONFIGS = ['.mcp.json', '.codex/config.toml', '.gemini/settings.json', '.kimi/mcp.json'];

export function buildInstallPreview(req: McpInstallRequest, existingCaps?: CapabilityEntry[]): McpInstallPreview {
  if (!req.id || typeof req.id !== 'string') {
    throw new Error('id must be a non-empty string');
  }
  if (req.args !== undefined && (!Array.isArray(req.args) || !req.args.every((a) => typeof a === 'string'))) {
    throw new Error('args must be an array of strings');
  }
  if (req.env !== undefined && (typeof req.env !== 'object' || req.env === null || Array.isArray(req.env))) {
    throw new Error('env must be a Record<string, string>');
  }
  if (
    req.headers !== undefined &&
    (typeof req.headers !== 'object' || req.headers === null || Array.isArray(req.headers))
  ) {
    throw new Error('headers must be a Record<string, string>');
  }
  if (req.url !== undefined && typeof req.url !== 'string') {
    throw new Error('url must be a string');
  }
  if (req.resolver !== undefined && typeof req.resolver !== 'string') {
    throw new Error('resolver must be a string');
  }
  const hasResolver = !!req.resolver;
  const controlledAccess = detectControlledAccessTool(req);
  const entry: CapabilityEntry = {
    id: req.id,
    type: 'mcp',
    enabled: !controlledAccess,
    source: 'external',
    mcpServer: {
      transport: req.transport ?? 'stdio',
      command: req.command ?? '',
      args: req.args ?? [],
      ...(req.url && { url: req.url }),
      ...(req.headers && { headers: req.headers }),
      ...(req.env && { env: req.env }),
      ...(hasResolver && { resolver: req.resolver }),
    },
    ...(req.ecosystem && MARKETPLACE_ECOSYSTEMS.includes(req.ecosystem) && { ecosystem: req.ecosystem }),
  };

  const willProbe =
    entry.enabled && entry.mcpServer?.transport !== 'streamableHttp' && !hasResolver && !!(req.command || req.url);

  const risks: string[] = [];
  if (existingCaps?.some((c) => c.id === req.id && c.type === 'mcp')) {
    risks.push(`MCP "${req.id}" already exists — install will overwrite`);
  }
  if (!req.command && !req.resolver && !req.url) {
    risks.push('No command, resolver, or URL — MCP will be unresolvable');
  }
  if (controlledAccess) {
    risks.push(
      `${controlledAccess.label} is default disabled; enable only after task-scoped authorization.`,
      `${controlledAccess.label} requires visible capability audit / tool usage evidence for every install, toggle, or update.`,
      `${controlledAccess.label} high-risk actions require confirmation before external writes, batch operations, or credentialed access.`,
    );
  }

  return { entry, cliConfigsAffected: CLI_CONFIGS, willProbe, risks };
}

function detectControlledAccessTool(req: McpInstallRequest): { label: string } | null {
  const haystack = [req.id, req.command, req.resolver, req.url, ...(req.args ?? [])]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

  if (/\bfigma\b/.test(haystack)) return { label: 'Figma MCP' };
  if (/\bopen[-_ ]?cli\b/.test(haystack)) return { label: 'opencli MCP' };
  return null;
}
