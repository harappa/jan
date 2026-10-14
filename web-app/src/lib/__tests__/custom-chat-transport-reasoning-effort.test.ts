import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import type * as ProviderCaps from '@/lib/providerCaps'

// The effort chosen in the chat input reaches the request as the AI SDK's
// `providerOptions` (the real buildReasoningProviderOptions runs here), so
// capture what streamText is given.
const streamTextCalls: Array<Record<string, unknown>> = []

const h = vi.hoisted(() => ({
  providerId: 'azure',
  serviceHub: null as unknown,
}))

h.serviceHub = {
  mcp: () => ({
    getTools: vi.fn(async () => []),
    getToolsForServers: vi.fn(async () => []),
    getServerSummaries: vi.fn(async () => []),
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
  provider: 'azure',
  active: true,
  api_key: 'k',
  base_url: 'https://example.openai.azure.com/openai/v1',
  models: [{ id: 'gpt-6.1-sol', capabilities: [] as string[] }],
  settings: [] as Array<{ key: string; controller_props: { value: boolean } }>,
}
const selectedModel: {
  id: string
  capabilities: string[]
  settings?: Record<string, { controller_props: { value: string } }>
} = { id: 'gpt-6.1-sol', capabilities: [] }

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
      selectedProvider: h.providerId,
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
    getState: () =>
      new Proxy(
        {},
        {
          get: () => () => undefined,
        }
      ),
  },
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => []) }))
vi.mock('@janhq/tauri-plugin-llamacpp-api', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadLlamaModel: vi.fn(),
}))
vi.mock('@/lib/llamacppRouterProps', () => ({
  getLlamacppExtension: () => ({ getModelProps: vi.fn() }),
}))
vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: vi.fn(async () => []) },
}))
vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))
vi.mock('@/lib/providerCaps', async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderCaps>()),
  isPredefinedRemoteProvider: () => false,
  getProviderApiType: () => 'openai',
}))
vi.mock('../model-factory', () => ({
  ModelFactory: {
    createModel: vi.fn(async () => ({ modelId: 'gpt-6.1-sol' })),
  },
}))

import { CustomChatTransport } from '../custom-chat-transport'

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

const sendOnce = async () => {
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
  expect(streamTextCalls).toHaveLength(1)
  return streamTextCalls[0]
}

describe('reasoning effort for an Azure model', () => {
  beforeEach(() => {
    streamTextCalls.length = 0
    h.providerId = 'azure'
    provider.provider = 'azure'
    delete selectedModel.settings
  })

  it('sends the chosen effort with a reasoning summary', async () => {
    selectedModel.settings = {
      thinking_budget_tokens: { controller_props: { value: 'xhigh' } },
    }
    const call = await sendOnce()
    expect(call.providerOptions).toEqual({
      openai: { reasoningEffort: 'xhigh', reasoningSummary: 'auto' },
    })
  })

  it('sends no reasoning options at the model default', async () => {
    const call = await sendOnce()
    expect(call.providerOptions).toBeUndefined()
  })
})
