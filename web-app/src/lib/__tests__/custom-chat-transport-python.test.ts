import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

const streamTextCalls: Array<Record<string, unknown>> = []

const h = vi.hoisted(() => ({
  serviceHub: null as unknown,
  python: { available: true } as { available: boolean; reason?: string },
  getPythonStatus: vi.fn(),
}))

h.serviceHub = {
  mcp: () => ({
    getTools: vi.fn(async () => []),
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
// The sandboxed shell is out of this test: no shell schema, no shell section.
vi.mock('@/lib/agentTools', () => ({
  CHAT_AGENT_TOOL_NAMES: new Set(['shell']),
  getAgentToolSchemas: vi.fn(async () => []),
  memoryDigestNow: () => '',
  refreshMemoryDigest: vi.fn(async () => undefined),
  sandboxEnforces: () => false,
}))
vi.mock('../pythonTool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pythonTool')>()),
  getPythonStatus: () => h.getPythonStatus(),
}))

import { CustomChatTransport } from '../custom-chat-transport'
import {
  PYTHON_SYSTEM_SECTION,
  PYTHON_TOOL_DESCRIPTION,
  PYTHON_TOOL_INPUT_SCHEMA,
} from '../pythonTool'

const user = (id: string, text: string): UIMessage =>
  ({ id, role: 'user', parts: [{ type: 'text', text }] }) as UIMessage
const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage

async function drain(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader()
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

const send = (transport: CustomChatTransport, messages: UIMessage[]) =>
  transport.sendMessages({
    chatId: 'thread-1',
    messages,
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })

describe('CustomChatTransport python tool', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    h.python = { available: true }
    h.getPythonStatus.mockReset().mockImplementation(async () => h.python)
    selectedModel.capabilities = ['tools']
  })

  it('offers python with its description and system section when it is available', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))

    const call = streamTextCalls[0]
    const tools = call.tools as Record<
      string,
      { description: string; inputSchema: unknown }
    >
    expect(Object.keys(tools)).toContain('python')
    expect(tools.python.description).toBe(PYTHON_TOOL_DESCRIPTION)
    expect(call.system as string).toContain(PYTHON_SYSTEM_SECTION)
    expect(call.system as string).toContain('you are jan')
  })

  it('offers the declared input schema', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await transport.refreshTools()
    const tool = transport.getTools().python as unknown as {
      inputSchema: { jsonSchema: unknown }
    }
    expect(tool.inputSchema.jsonSchema).toEqual(PYTHON_TOOL_INPUT_SCHEMA)
  })

  it('offers neither the tool nor the section when python is unavailable', async () => {
    h.python = { available: false, reason: 'no sandbox' }
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))

    const call = streamTextCalls[0]
    expect(Object.keys((call.tools as object) ?? {})).not.toContain('python')
    expect(String(call.system)).not.toContain('# Python')
  })

  it('offers nothing when the model has no tools capability', async () => {
    selectedModel.capabilities = []
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await drain(await send(transport, [user('u1', 'hello')]))

    const call = streamTextCalls[0]
    expect(Object.keys((call.tools as object) ?? {})).not.toContain('python')
    expect(String(call.system)).not.toContain('# Python')
  })

  it('does not ask for the status when the model cannot use tools', async () => {
    selectedModel.capabilities = []
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    await transport.refreshTools()
    expect(h.getPythonStatus).not.toHaveBeenCalled()
  })

  it('keeps the system prompt and the tool description identical on the next send', async () => {
    const transport = new CustomChatTransport('you are jan', 'thread-1')
    const turn1 = [user('u1', 'hello')]
    await drain(await send(transport, turn1))
    await drain(
      await send(transport, [
        ...turn1,
        assistant('a1', 'hi'),
        user('u2', 'again'),
      ])
    )

    const [first, second] = streamTextCalls
    expect(JSON.stringify(second.system)).toBe(JSON.stringify(first.system))
    const firstTools = first.tools as Record<string, { description: string }>
    const secondTools = second.tools as Record<string, { description: string }>
    expect(Object.keys(secondTools)).toEqual(Object.keys(firstTools))
    expect(secondTools.python.description).toBe(firstTools.python.description)
    expect(JSON.stringify(secondTools)).toBe(JSON.stringify(firstTools))
  })
})
