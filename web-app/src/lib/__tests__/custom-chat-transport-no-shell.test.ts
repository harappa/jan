import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

const streamTextCalls: Array<Record<string, unknown>> = []

const h = vi.hoisted(() => ({
  serviceHub: null as unknown,
  mcpTools: [] as Array<Record<string, unknown>>,
  toolSchemas: vi.fn(),
  sandboxStatus: vi.fn(),
}))

h.serviceHub = {
  mcp: () => ({
    getTools: vi.fn(async () => h.mcpTools),
  }),
  rag: () => ({ getTools: async () => [] }),
}

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai')
  return {
    ...actual,
    streamText: (args: Record<string, unknown>) => {
      streamTextCalls.push(args)
      return {
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.close()
            },
          }),
      }
    },
  }
})

const provider = {
  provider: 'openai',
  active: true,
  api_key: 'k',
  models: [{ id: 'gpt', capabilities: ['tools'] }],
  settings: [] as Array<{ key: string; controller_props: { value: boolean } }>,
}
const selectedModel = { id: 'gpt', capabilities: ['tools'] as string[] }

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: h.serviceHub }) },
  getServiceHub: () => ({ app: () => ({ getJanDataFolder: async () => '/data' }) }),
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ getDisabledTools: () => [] }) },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel,
      selectedProvider: 'openai',
      getProviderByName: () => provider,
    }),
  },
}))
vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: null }) },
}))
vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: {} }) },
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))
vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: {
    getState: () => ({ settings: { enableSmartToolRouting: false } }),
  },
}))
vi.mock('@/hooks/useAppState', () => ({
  useAppState: {
    getState: () => new Proxy({}, { get: () => () => undefined }),
  },
}))
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => null }) },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadLlamaModel: vi.fn(),
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/reasoningProviderOptions', () => ({
  buildReasoningProviderOptions: () => undefined,
}))
vi.mock('../model-factory', () => ({
  ModelFactory: { createModel: vi.fn(async () => ({ modelId: 'gpt' })) },
}))
// The real agentTools runs here: the point is what chat does with the shell
// schema the desktop offers. Only the Tauri plugin underneath is replaced, with
// an enforcing sandbox, so nothing but chat's own choice keeps the shell out.
vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  toolSchemas: () => h.toolSchemas(),
  sandboxStatus: () => h.sandboxStatus(),
  executeTool: vi.fn(),
  threadWorkspaceDelete: vi.fn(),
  threadWorkspaceSweep: vi.fn(),
  memoryCatalog: vi.fn(async () => []),
  memoryRead: vi.fn(async () => ''),
  subagentResultReserve: vi.fn(),
  subagentResultFill: vi.fn(),
  attachmentImport: vi.fn(),
}))
vi.mock('../pythonTool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pythonTool')>()),
  getPythonStatus: async () => ({ available: false }),
}))

import { CustomChatTransport } from '../custom-chat-transport'

const schema = (name: string) => ({
  type: 'function' as const,
  function: { name, description: `${name} desc`, parameters: {} },
})

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

describe('CustomChatTransport without the shell tool', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    selectedModel.capabilities = ['tools']
    h.mcpTools = []
    h.sandboxStatus.mockReset().mockResolvedValue({
      backend: 'bubblewrap',
      enforces: true,
    })
    h.toolSchemas
      .mockReset()
      .mockResolvedValue(['shell', 'read', 'write'].map(schema))
  })

  it('offers no shell tool and no built-in agent tool, even with an enforcing sandbox', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(
      await transport.sendMessages({
        chatId: 'thread-1',
        messages: [user('u1', 'hello')],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })
    )

    const tools = (streamTextCalls[0].tools ?? {}) as Record<string, unknown>
    expect(Object.keys(tools)).not.toContain('shell')
    expect(Object.keys(tools)).not.toContain('read')
    expect(Object.keys(tools)).not.toContain('write')
  })

  it('has no Shell section in the system prompt', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(
      await transport.sendMessages({
        chatId: 'thread-1',
        messages: [user('u1', 'hello')],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })
    )

    expect(String(streamTextCalls[0].system)).not.toContain('# Shell')
    expect(transport.buildAgentToolsSystemInstruction()).not.toContain(
      '# Shell'
    )
  })

  // An MCP server may legitimately ship a tool called `shell`. Chat no longer
  // owns that name, so it must reach the model as the MCP server's tool.
  it('keeps an MCP tool named shell', async () => {
    h.mcpTools = [
      {
        name: 'shell',
        description: 'an MCP shell',
        inputSchema: {},
        server: 'srv',
      },
    ]
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await transport.refreshTools()

    const tools = transport.getTools() as unknown as Record<
      string,
      { description: string }
    >
    expect(tools.shell.description).toBe('an MCP shell')
  })
})
