import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = {
  apiFetch: vi.fn(),
};

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

const MOCK_RESULT = {
  artifactId: 'mcp-memory',
  artifactKind: 'mcp_server' as const,
  displayName: 'MCP Memory',
  ecosystem: 'claude' as const,
  sourceLocator: 'npm:@anthropic/mcp-memory',
  trustLevel: 'verified' as const,
  componentSummary: 'Persistent memory using local knowledge graph',
  transport: 'stdio' as const,
};

const MOCK_PLAN = {
  mode: 'direct_mcp' as const,
  mcpEntry: {
    id: 'mcp-memory',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['@anthropic/mcp-memory'],
  },
};

describe('marketplaceStore', () => {
  beforeEach(async () => {
    mocks.apiFetch.mockReset();
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({
      results: [],
      selectedResult: null,
      installPlan: null,
      loading: false,
      error: null,
      query: '',
      ecosystemFilter: [],
      trustFilter: [],
      artifactKindsFilter: [],
    });
  });

  it('search populates results from API', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ results: [MOCK_RESULT] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('memory');

    expect(useMarketplaceStore.getState().results).toHaveLength(1);
    expect(useMarketplaceStore.getState().results[0].artifactId).toBe('mcp-memory');
    expect(useMarketplaceStore.getState().query).toBe('memory');
  });

  it('search passes ecosystem filter as CSV', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({ ecosystemFilter: ['claude', 'codex'] });

    await useMarketplaceStore.getState().search('test');

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('ecosystems=claude%2Ccodex'));
  });

  it('search passes trust filter as CSV', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({ trustFilter: ['verified'] });

    await useMarketplaceStore.getState().search('test');

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('trustLevels=verified'));
  });

  it('search sets loading true then false', async () => {
    let resolveApi: ((v: unknown) => void) | undefined;
    mocks.apiFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveApi = r;
      }),
    );
    const { useMarketplaceStore } = await import('../marketplaceStore');

    const promise = useMarketplaceStore.getState().search('memory');
    expect(useMarketplaceStore.getState().loading).toBe(true);

    expect(resolveApi).toBeDefined();
    const fulfillApi = resolveApi;
    if (!fulfillApi) throw new Error('api promise resolver was not initialized');
    fulfillApi({ json: () => Promise.resolve({ results: [] }) });
    await promise;
    expect(useMarketplaceStore.getState().loading).toBe(false);
  });

  it('search sets error on failure', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('Network error'));
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('memory');

    expect(useMarketplaceStore.getState().error).toBe('Network error');
    expect(useMarketplaceStore.getState().loading).toBe(false);
  });

  it('search sets error on non-2xx response', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Missing required query parameter: q' }),
    });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('');

    expect(useMarketplaceStore.getState().error).toBe('Missing required query parameter: q');
    expect(useMarketplaceStore.getState().loading).toBe(false);
    expect(useMarketplaceStore.getState().results).toEqual([]);
  });

  it('search falls back to empty results when API omits results', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('memory');

    expect(useMarketplaceStore.getState().results).toEqual([]);
    expect(useMarketplaceStore.getState().loading).toBe(false);
  });

  it('browse calls search endpoint without a dangling query string', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [MOCK_RESULT] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().browse();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/marketplace/search');
    expect(useMarketplaceStore.getState().results).toHaveLength(1);
  });

  it('browse clears stale search query', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({ query: 'memory' });

    await useMarketplaceStore.getState().browse();

    expect(useMarketplaceStore.getState().query).toBe('');
  });

  it('getInstallPlan fetches plan via POST', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ plan: MOCK_PLAN }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().getInstallPlan('claude', 'mcp-memory');

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/marketplace/install/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ecosystem: 'claude', artifactId: 'mcp-memory' }),
    });
    expect(useMarketplaceStore.getState().installPlan).toEqual(MOCK_PLAN);
  });

  it('selectResult sets selectedResult', async () => {
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.getState().selectResult(MOCK_RESULT);
    expect(useMarketplaceStore.getState().selectedResult).toEqual(MOCK_RESULT);
  });

  it('setEcosystemFilter re-triggers search when query exists', async () => {
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('memory');
    mocks.apiFetch.mockClear();
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [MOCK_RESULT] }) });

    useMarketplaceStore.getState().setEcosystemFilter(['claude']);
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('ecosystems=claude'));
    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('q=memory'));
  });

  it('setEcosystemFilter skips re-search when value unchanged', async () => {
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    useMarketplaceStore.setState({ ecosystemFilter: ['claude'] });
    await useMarketplaceStore.getState().search('memory');
    mocks.apiFetch.mockClear();

    useMarketplaceStore.getState().setEcosystemFilter(['claude']);

    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('setEcosystemFilter does not search when no query', async () => {
    const { useMarketplaceStore } = await import('../marketplaceStore');

    useMarketplaceStore.getState().setEcosystemFilter(['codex']);

    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('setTrustFilter re-triggers search when query exists', async () => {
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('test');
    mocks.apiFetch.mockClear();
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });

    useMarketplaceStore.getState().setTrustFilter(['official']);
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('trustLevels=official'));
  });

  it('search passes artifactKinds filter as CSV', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({ artifactKindsFilter: ['mcp_server'] });

    await useMarketplaceStore.getState().search('test');

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('artifactKinds=mcp_server'));
  });

  it('setArtifactKindsFilter re-triggers search when query exists', async () => {
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });
    const { useMarketplaceStore } = await import('../marketplaceStore');

    await useMarketplaceStore.getState().search('memory');
    mocks.apiFetch.mockClear();
    mocks.apiFetch.mockResolvedValue({ json: () => Promise.resolve({ results: [] }) });

    useMarketplaceStore.getState().setArtifactKindsFilter(['mcp_server']);
    await vi.waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('artifactKinds=mcp_server'));
  });

  it('clearSelection resets selectedResult and installPlan', async () => {
    const { useMarketplaceStore } = await import('../marketplaceStore');
    useMarketplaceStore.setState({ selectedResult: MOCK_RESULT, installPlan: MOCK_PLAN });

    useMarketplaceStore.getState().clearSelection();

    expect(useMarketplaceStore.getState().selectedResult).toBeNull();
    expect(useMarketplaceStore.getState().installPlan).toBeNull();
  });
});
