import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

const state = vi.hoisted(() => ({
  tools: [] as { name: string; server: string }[],
  ragToolNames: new Set<string>(),
}))
const pythonStatus = vi.hoisted(() => ({ available: true }))

vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: (s: typeof state) => unknown) => selector(state),
}))
vi.mock('@/hooks/useWebSearchConfig', () => ({
  getProviderMeta: () => ({ label: 'Exa' }),
  useWebSearchConfig: (selector: (s: { searchProvider: string }) => unknown) =>
    selector({ searchProvider: 'exa' }),
}))
vi.mock('@/lib/pythonTool', () => ({
  PYTHON_TOOL_NAME: 'python',
  getPythonStatus: () => Promise.resolve({ available: pythonStatus.available }),
}))

import { useToolOrigin } from '../useToolOrigin'

const mcpPython = { name: 'python', server: 'sandbox-mcp' }

describe('useToolOrigin', () => {
  beforeEach(() => {
    state.tools = []
    state.ragToolNames = new Set()
    pythonStatus.available = true
  })

  // Python is available: the transport offers the built-in in place of any MCP
  // tool of that name and the thread route runs it, so the card is the
  // built-in's however the tool list looks.
  it.each([
    ['no MCP tool of that name', []],
    ['an MCP tool of that name', [mcpPython]],
  ])(
    'shows python as an agent tool when available, with %s',
    async (_, tools) => {
      state.tools = tools
      const { result } = renderHook(() => useToolOrigin('python'))
      await act(async () => {})
      expect(result.current).toEqual({ kind: 'agent' })
    }
  )

  // Not available: a tool of that name is the MCP server's.
  it('leaves python with its MCP server when unavailable', async () => {
    pythonStatus.available = false
    state.tools = [mcpPython]
    const { result } = renderHook(() => useToolOrigin('python'))
    await act(async () => {})
    expect(result.current).toEqual({ kind: 'mcp', detail: 'sandbox-mcp' })
  })

  // Threads recorded where the sandbox ran stay readable on a machine without it.
  it('keeps an old python call readable when unavailable and no server has it', async () => {
    pythonStatus.available = false
    const { result } = renderHook(() => useToolOrigin('python'))
    await act(async () => {})
    expect(result.current).toEqual({ kind: 'agent' })
  })

  it('still classifies shell as an agent tool', () => {
    const { result } = renderHook(() => useToolOrigin('shell'))
    expect(result.current).toEqual({ kind: 'agent' })
  })
})
