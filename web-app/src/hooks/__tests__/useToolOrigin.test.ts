import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const state = vi.hoisted(() => ({
  tools: [] as { name: string; server: string }[],
  ragToolNames: new Set<string>(),
}))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: (s: typeof state) => unknown) => selector(state),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  getProviderMeta: () => ({ label: 'Exa' }),
  useWebSearchConfig: (selector: (s: { searchProvider: string }) => unknown) =>
    selector({ searchProvider: 'exa' }),
}))

import { useToolOrigin } from '../useToolOrigin'

describe('useToolOrigin', () => {
  beforeEach(() => {
    state.tools = []
    state.ragToolNames = new Set()
  })

  it('classifies the python tool as an agent tool', () => {
    const { result } = renderHook(() => useToolOrigin('python'))
    expect(result.current).toEqual({ kind: 'agent' })
  })

  // The built-in is only offered when it can run; otherwise a tool named
  // `python` belongs to the MCP server that registered it.
  it('leaves a python tool of an MCP server with that server', () => {
    state.tools = [{ name: 'python', server: 'sandbox-mcp' }]
    const { result } = renderHook(() => useToolOrigin('python'))
    expect(result.current).toEqual({ kind: 'mcp', detail: 'sandbox-mcp' })
  })

  it('still classifies shell as an agent tool', () => {
    const { result } = renderHook(() => useToolOrigin('shell'))
    expect(result.current).toEqual({ kind: 'agent' })
  })
})
