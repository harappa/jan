/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'

// -----------------------------------------------------------------------------
// Hoisted shared state + mocks (needed because vi.mock factory runs first)
// -----------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const mockSendMessage = vi.fn()
  const mockRegenerate = vi.fn()
  const mockStop = vi.fn()
  const mockAddToolOutput = vi.fn()
  const mockSetChatMessages = vi.fn()
  const mockUpdateRag = vi.fn()
  const mockSetContinueFromContent = vi.fn()

  const chatState: { messages: any[]; status: string; error: Error | null } = {
    messages: [],
    status: 'ready',
    error: null,
  }

  const threadsState: any = {
    threads: {
      'thread-1': {
        id: 'thread-1',
        title: 'My Thread',
        metadata: {},
        assistants: [],
        model: { id: 'gpt-x', provider: 'openai' },
      },
    },
    setCurrentThreadId: vi.fn(),
    updateThread: vi.fn(),
  }
  const useThreadsMock: any = (selector: any) => selector(threadsState)
  useThreadsMock.getState = () => threadsState

  const messagesState: any = {
    setMessages: vi.fn(),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getMessages: vi.fn(() => []),
  }
  const useMessagesMock: any = (selector: any) => selector(messagesState)
  useMessagesMock.getState = () => messagesState

  const appStateState = {
    ragToolNames: new Set<string>(),
    mcpToolNames: new Set<string>(),
    tools: [] as Array<{ name: string; server?: string }>,
    setOomError: vi.fn(),
    setBackendError: vi.fn(),
    busyThreads: {} as Record<string, boolean>,
    embeddingThreads: {} as Record<string, boolean>,
    setThreadBusy: vi.fn(),
    setThreadEmbedding: vi.fn(),
  }
  const useAppStateMock: any = (selector: any) => selector(appStateState)
  useAppStateMock.getState = () => appStateState

  const modelProviderState: any = {
    selectedModel: {
      id: 'gpt-x',
      capabilities: ['tools'],
      settings: {
        ctx_len: { controller_props: { value: 4096, max: 131072 } },
        auto_increase_ctx_len: { controller_props: { value: true } },
      },
    },
    selectedProvider: 'openai',
    getProviderByName: vi.fn((name: string) => ({
      provider: name,
      models: [
        {
          id: 'gpt-x',
          settings: {
            ctx_len: { controller_props: { value: 4096, max: 131072 } },
          },
        },
      ],
    })),
    updateProvider: vi.fn(),
  }
  const useModelProviderMock: any = (selector: any) => selector(modelProviderState)
  useModelProviderMock.getState = () => modelProviderState

  // One session data object per thread, like the real store: consecutive
  // turns and loops of a thread share it.
  const sessionDataByThread: Record<string, any> = {}
  const sessionDataFor = (id: string) =>
    (sessionDataByThread[id] ??= { tools: [] })
  const chatSessionsState: any = {
    sessions: {},
    getSessionData: vi.fn(sessionDataFor),
    peekSessionData: vi.fn((id: string) => sessionDataByThread[id]),
  }
  const useChatSessionsMock: any = (selector: any) => selector(chatSessionsState)
  useChatSessionsMock.getState = () => chatSessionsState

  const attachmentsState: any = {
    getAttachments: vi.fn(() => []),
    clearAttachments: vi.fn(),
    setAttachments: vi.fn(),
  }
  const useChatAttachmentsMock: any = (selector: any) => selector(attachmentsState)
  useChatAttachmentsMock.getState = () => attachmentsState

  const useAttachmentsState: any = { enabled: true, parseMode: 'auto' }
  const useAttachmentsMock: any = (selector: any) => selector(useAttachmentsState)
  useAttachmentsMock.getState = () => useAttachmentsState

  const toolAvailableState: any = {
    getDisabledToolsForThread: vi.fn(() => []),
  }
  const useToolAvailableMock: any = (selector: any) => selector(toolAvailableState)
  useToolAvailableMock.getState = () => toolAvailableState

  const lastAssistantComplete = vi.fn((..._args: unknown[]) => false)

  const toolApprovalState: any = {
    // Read by the real approval-requests store when a test swaps it in.
    allowAllMCPPermissions: false,
    isToolApproved: vi.fn(() => false),
    approveToolForThread: vi.fn(),
    clearPendingForThread: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
  }
  const useToolApprovalMock: any = (selector: any) => selector(toolApprovalState)
  useToolApprovalMock.getState = () => toolApprovalState
  // Transient approval store shares the same backing object so existing
  // toolApprovalState.requestApproval / clearPendingForThread refs keep working.
  const useToolApprovalRequestsMock: any = (selector: any) =>
    selector(toolApprovalState)
  useToolApprovalRequestsMock.getState = () => toolApprovalState

  const agentModeState: any = { agentThreads: {} }
  const useAgentModeMock: any = (selector: any) => selector(agentModeState)
  useAgentModeMock.getState = () => agentModeState

  const messageQueueState: any = {
    dequeue: vi.fn(() => null),
    clearQueue: vi.fn(),
  }
  const useMessageQueueMock: any = (_selector: any) => undefined
  useMessageQueueMock.getState = () => messageQueueState

  return {
    routeThreadId: 'thread-1',
    sessionDataByThread,
    sessionDataFor,
    mockSendMessage,
    mockRegenerate,
    mockStop,
    mockAddToolOutput,
    mockSetChatMessages,
    mockUpdateRag,
    mockSetContinueFromContent,
    chatState,
    threadsState,
    useThreadsMock,
    messagesState,
    useMessagesMock,
    appStateState,
    useAppStateMock,
    modelProviderState,
    useModelProviderMock,
    chatSessionsState,
    useChatSessionsMock,
    attachmentsState,
    useChatAttachmentsMock,
    useAttachmentsState,
    useAttachmentsMock,
    toolAvailableState,
    useToolAvailableMock,
    toolApprovalState,
    lastAssistantComplete,
    useToolApprovalMock,
    useToolApprovalRequestsMock,
    agentModeState,
    useAgentModeMock,
    messageQueueState,
    useMessageQueueMock,
  }
})

// -----------------------------------------------------------------------------
// Module mocks
// -----------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({ ...config, id: '/threads/$threadId' }),
  useParams: () => ({ threadId: h.routeThreadId }),
  useSearch: () => ({ threadModel: undefined }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => <div data-testid="header-page">{children}</div>,
}))

vi.mock('@/containers/DropdownModelProvider', () => ({
  default: ({ model }: any) => (
    <div data-testid="model-dropdown">{model ? model.id : 'no-model'}</div>
  ),
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ onSubmit, onStop, chatStatus, toolsRunning }: any) => (
    <div data-testid="chat-input">
      <span data-testid="chat-status">{chatStatus}</span>
      <span data-testid="tools-running">{String(!!toolsRunning)}</span>
      <button
        data-testid="chat-send"
        onClick={() => onSubmit('hello world', undefined)}
      >
        send
      </button>
      <button
        data-testid="chat-send-ref"
        onClick={() =>
          onSubmit(
            'summarise\n\n---\nReferenced file contents:\n\nbody',
            undefined,
            undefined,
            'summarise @notes.md'
          )
        }
      >
        send with reference
      </button>
      <button data-testid="chat-stop" onClick={() => onStop()}>
        stop
      </button>
    </div>
  ),
}))

vi.mock('@/containers/MessageItem', () => ({
  MessageItem: ({
    message,
    onRegenerate,
    onEdit,
    onDelete,
    versionInfo,
    onSwitchVersion,
  }: any) => (
    <div data-testid={`message-${message.id}`} data-role={message.role}>
      <span>{message.id}</span>
      {versionInfo && (
        <span data-testid={`version-${message.id}`}>
          {versionInfo.index}/{versionInfo.count}
        </span>
      )}
      <button
        data-testid={`prev-${message.id}`}
        onClick={() => onSwitchVersion?.(message.id, -1)}
      >
        prev
      </button>
      <button
        data-testid={`regen-${message.id}`}
        onClick={() => onRegenerate(message.id)}
      >
        regen
      </button>
      <button
        data-testid={`edit-${message.id}`}
        onClick={() => onEdit(message.id, 'edited text')}
      >
        edit
      </button>
      <button
        data-testid={`del-${message.id}`}
        onClick={() => onDelete(message.id)}
      >
        del
      </button>
    </div>
  ),
}))

vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: any) => <div>{children}</div>,
  ConversationContent: ({ children }: any) => <div>{children}</div>,
  ConversationScrollButton: () => <div data-testid="scroll-btn" />,
}))

vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: any) => <div data-testid="shimmer">{children}</div>,
}))

vi.mock('@/components/PromptProgress', () => ({
  PromptProgress: () => <div data-testid="prompt-progress" />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

vi.mock('@tabler/icons-react', () => ({
  IconAlertCircle: () => <span />,
  IconRefresh: () => <span />,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/lib/instructionTemplate', () => ({
  renderInstructions: (i: string) => `rendered:${i}`,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => ({
        listAttachmentsForProject: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}))

vi.mock('@/lib/messages', () => ({
  convertThreadMessagesToUIMessages: (msgs: any[]) =>
    msgs.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: 'text', text: m.content?.[0]?.text?.value ?? '' }],
    })),
  extractContentPartsFromUIMessage: (msg: any) =>
    msg.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => ({ type: 'text', text: { value: p.text, annotations: [] } })),
  uiMessageHasMeaningfulContent: (msg: any) =>
    !!msg?.parts?.some((p: any) => p.type === 'text' && p.text?.trim()),
}))

vi.mock('@/lib/completion', () => ({
  newUserThreadContent: (threadId: string, text: string, _a: any, id: string) => ({
    id,
    thread_id: threadId,
    role: 'user',
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    metadata: {},
  }),
}))

vi.mock('@/lib/attachmentProcessing', () => ({
  processAttachmentsForSend: vi
    .fn()
    .mockResolvedValue({ processedAttachments: [], hasEmbeddedDocuments: false }),
  resolveAutoInlineBudget: vi.fn().mockResolvedValue(6144),
  needsIngestionChoice: vi.fn(
    (doc: any, pref: string) => (doc.parseMode ?? pref) === 'auto'
  ),
  promptIngestionChoices: vi.fn(),
  applyIngestionChoices: (atts: any[], choices: Map<string, string>) =>
    atts.map((a) =>
      choices.has(a.path) ? { ...a, parseMode: choices.get(a.path) } : a
    ),
}))

vi.mock('@/lib/thread-title-summarizer', () => ({
  generateThreadTitle: vi.fn().mockResolvedValue('Short title'),
}))

vi.mock('@/types/attachment', () => ({
  createImageAttachment: (x: any) => ({ type: 'image', ...x }),
}))

vi.mock('ai', () => ({
  generateId: () => 'gen-id',
  lastAssistantMessageIsCompleteWithToolCalls: (...args: unknown[]) =>
    h.lastAssistantComplete(...args),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (_args: any) => {
    ;(h as any).capturedOnFinish = _args?.onFinish
    ;(h as any).capturedOnToolCall = _args?.onToolCall
    ;(h as any).capturedSendAutomaticallyWhen = _args?.sendAutomaticallyWhen
    return {
      messages: h.chatState.messages,
      status: h.chatState.status,
      error: h.chatState.error,
      sendMessage: h.mockSendMessage,
      regenerate: h.mockRegenerate,
      setMessages: h.mockSetChatMessages,
      stop: h.mockStop,
      addToolOutput: h.mockAddToolOutput,
      updateRagToolsAvailability: h.mockUpdateRag,
      setContinueFromContent: h.mockSetContinueFromContent,
    }
  },
}))

vi.mock('@/hooks/useThreads', () => ({ useThreads: h.useThreadsMock }))
vi.mock('@/hooks/useMessages', () => ({ useMessages: h.useMessagesMock }))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAppState', () => ({ useAppState: h.useAppStateMock }))
vi.mock('@/hooks/useModelProvider', () => ({ useModelProvider: h.useModelProviderMock }))
vi.mock('@/stores/chat-session-store', () => ({ useChatSessions: h.useChatSessionsMock }))
vi.mock('@/hooks/useChatAttachments', () => ({
  useChatAttachments: h.useChatAttachmentsMock,
  NEW_THREAD_ATTACHMENT_KEY: '__new-thread__',
}))
vi.mock('@/hooks/useAttachments', () => ({ useAttachments: h.useAttachmentsMock }))
vi.mock('@/hooks/useToolAvailable', () => ({ useToolAvailable: h.useToolAvailableMock }))
vi.mock('@/hooks/useToolApproval', () => ({ useToolApproval: h.useToolApprovalMock }))
vi.mock('@/hooks/useToolApprovalRequests', () => ({
  useToolApprovalRequests: h.useToolApprovalRequestsMock,
}))
vi.mock('@/hooks/useAgentMode', () => ({ useAgentMode: h.useAgentModeMock }))
vi.mock('@/stores/message-queue-store', () => ({ useMessageQueue: h.useMessageQueueMock }))

vi.mock('@/hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    forceScrollToBottom: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('@janhq/core', () => ({
  MessageStatus: { Ready: 'ready' },
  ChatCompletionRole: { Assistant: 'assistant', User: 'user' },
  ContentType: { Text: 'text' },
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
  VectorDBExtension: class {},
}))

vi.mock('@/constants/chat', () => ({
  SESSION_STORAGE_PREFIX: { INITIAL_MESSAGE: 'initial-message-' },
}))

vi.mock('@/utils/error', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/error')>()),
  OUT_OF_CONTEXT_SIZE: 'OUT_OF_CONTEXT_SIZE',
}))

// -----------------------------------------------------------------------------
// Import component AFTER mocks
// -----------------------------------------------------------------------------
import { Route } from '../$threadId'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'
import { useToolLoops } from '@/stores/tool-loop-store'
import { useMessageErrors } from '@/stores/message-errors'
import {
  processAttachmentsForSend,
  promptIngestionChoices,
  resolveAutoInlineBudget,
} from '@/lib/attachmentProcessing'
import { usePrompt } from '@/hooks/usePrompt'

// The global setup mock is a shared object, so an overridden factory has to be
// put back or it leaks into every later test.
const hub = getServiceHub() as unknown as Record<string, unknown>
const realMcp = hub.mcp

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('ThreadDetail route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.chatState.messages = []
    h.chatState.status = 'ready'
    h.chatState.error = null
    h.threadsState.threads['thread-1'] = {
      id: 'thread-1',
      title: 'My Thread',
      metadata: {},
      assistants: [],
      model: { id: 'gpt-x', provider: 'openai' },
    }
    h.threadsState.setCurrentThreadId = vi.fn()
    h.threadsState.updateThread = vi.fn()
    h.messagesState.getMessages = vi.fn(() => [
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: { value: 'hello', annotations: [] } }],
      },
    ])
    h.messagesState.addMessage = vi.fn()
    h.messagesState.updateMessage = vi.fn()
    h.messagesState.deleteMessage = vi.fn()
    h.messagesState.setMessages = vi.fn()
    h.routeThreadId = 'thread-1'
    for (const id of Object.keys(h.sessionDataByThread)) {
      delete h.sessionDataByThread[id]
    }
    h.chatSessionsState.getSessionData = vi.fn(h.sessionDataFor)
    h.chatSessionsState.peekSessionData = vi.fn(
      (id: string) => h.sessionDataByThread[id]
    )
    useToolLoops.setState({ running: {} })
    h.messageQueueState.dequeue = vi.fn(() => null)
    h.messageQueueState.clearQueue = vi.fn()
    h.agentModeState.agentThreads = {}
    h.modelProviderState.selectedProvider = 'openai'
    h.appStateState.oomError = undefined
    h.appStateState.backendError = undefined
    h.appStateState.ragToolNames = new Set<string>()
    h.appStateState.mcpToolNames = new Set<string>()
    h.appStateState.tools = []
    h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
    h.lastAssistantComplete.mockImplementation(() => false)
    h.mockAddToolOutput.mockReset()
    hub.mcp = realMcp
    useToolCallRuntime.getState().reset()
    sessionStorage.clear()
  })

  it('validateSearch returns threadModel from search params', () => {
    const searchModel = { id: 'm1', provider: 'p1' }
    const result = (Route as any).validateSearch({ threadModel: searchModel })
    expect(result.threadModel).toEqual(searchModel)
  })

  it('validateSearch handles missing threadModel', () => {
    const result = (Route as any).validateSearch({})
    expect(result.threadModel).toBeUndefined()
  })

  it('renders header, model dropdown, and chat input', () => {
    renderComponent()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('model-dropdown')).toHaveTextContent('gpt-x')
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('chat-status')).toHaveTextContent('ready')
  })

  it('sets current thread id on mount and resets on unmount', () => {
    const { unmount } = renderComponent()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenCalledWith('thread-1')
    unmount()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenLastCalledWith(undefined)
  })

  it('clears this thread pending tool approvals on unmount', () => {
    const { unmount } = renderComponent()
    unmount()
    expect(h.toolApprovalState.clearPendingForThread).toHaveBeenCalledWith('thread-1')
  })

  it('renders messages passed through useChat', () => {
    h.chatState.messages = [
      { id: 'm-a', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm-b', role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
    ]
    renderComponent()
    expect(screen.getByTestId('message-m-a')).toBeInTheDocument()
    expect(screen.getByTestId('message-m-b')).toBeInTheDocument()
  })

  it('submits user text via ChatInput -> sendMessage', async () => {
    renderComponent()
    await act(async () => {
      screen.getByTestId('chat-send').click()
    })
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(h.messagesState.addMessage).toHaveBeenCalled()
  })

  it('passes the auto-inline budget when sending documents', async () => {
    h.useAttachmentsState.autoInlineContextRatio = 0.75
    // 35 chars -> 10 estimated tokens + 4 per-message overhead.
    h.chatState.messages = [
      { id: 'u0', role: 'user', parts: [{ type: 'text', text: 'x'.repeat(35) }] },
    ]
    h.attachmentsState.getAttachments = vi.fn(() => [
      { name: 'sheet.xlsx', type: 'document', path: '/sheet.xlsx' },
    ])
    renderComponent()
    await act(async () => {
      screen.getByTestId('chat-send').click()
    })
    await waitFor(() => {
      expect(processAttachmentsForSend).toHaveBeenCalled()
    })
    expect(resolveAutoInlineBudget).toHaveBeenCalledWith(
      h.modelProviderState.selectedModel,
      'openai',
      0.75,
      14
    )
    expect(vi.mocked(processAttachmentsForSend).mock.calls[0][0]).toMatchObject({
      contextThreshold: 6144,
      parsePreference: 'auto',
    })
    expect(promptIngestionChoices).not.toHaveBeenCalled()
    h.attachmentsState.getAttachments = vi.fn(() => [])
  })

  describe('when the auto-inline budget is gone at send time', () => {
    const sheet = {
      name: 'sheet.xlsx',
      type: 'document',
      path: '/sheet.xlsx',
      parseMode: 'auto',
    }

    beforeEach(() => {
      // Cloud model, unloaded auto-fit model, or a conversation that has
      // outgrown the window all resolve to no budget.
      vi.mocked(resolveAutoInlineBudget).mockResolvedValueOnce(undefined)
      h.attachmentsState.getAttachments = vi.fn(() => [sheet])
    })

    it('asks the user and sends the document the way they chose', async () => {
      vi.mocked(promptIngestionChoices).mockResolvedValueOnce(
        new Map([['/sheet.xlsx', 'inline']])
      )
      renderComponent()
      await act(async () => {
        screen.getByTestId('chat-send').click()
      })
      await waitFor(() => {
        expect(processAttachmentsForSend).toHaveBeenCalled()
      })
      expect(promptIngestionChoices).toHaveBeenCalledWith([sheet])
      expect(
        vi.mocked(processAttachmentsForSend).mock.calls[0][0].attachments
      ).toEqual([{ ...sheet, parseMode: 'inline' }])
      h.attachmentsState.getAttachments = vi.fn(() => [])
    })

    it('cancelling keeps the draft and sends nothing', async () => {
      vi.mocked(promptIngestionChoices).mockResolvedValueOnce(undefined)
      renderComponent()
      await act(async () => {
        screen.getByTestId('chat-send').click()
      })
      await waitFor(() => {
        expect(h.attachmentsState.setAttachments).toHaveBeenCalledWith(
          'thread-1',
          [sheet]
        )
      })
      expect(usePrompt.getState().prompt).toBe('hello world')
      expect(processAttachmentsForSend).not.toHaveBeenCalled()
      expect(h.mockSendMessage).not.toHaveBeenCalled()
      expect(h.messagesState.addMessage).not.toHaveBeenCalled()
      h.attachmentsState.getAttachments = vi.fn(() => [])
      usePrompt.getState().resetPrompt()
    })

    it('cancelling restores the typed draft, not the expanded @references', async () => {
      vi.mocked(promptIngestionChoices).mockResolvedValueOnce(undefined)
      renderComponent()
      await act(async () => {
        screen.getByTestId('chat-send-ref').click()
      })
      await waitFor(() => {
        expect(usePrompt.getState().prompt).toBe('summarise @notes.md')
      })
      expect(h.mockSendMessage).not.toHaveBeenCalled()
      h.attachmentsState.getAttachments = vi.fn(() => [])
      usePrompt.getState().resetPrompt()
    })

    it('does not ask for project threads, whose files always embed', async () => {
      h.threadsState.threads['thread-1'].metadata = { project: { id: 'p1' } }
      renderComponent()
      await act(async () => {
        screen.getByTestId('chat-send').click()
      })
      await waitFor(() => {
        expect(processAttachmentsForSend).toHaveBeenCalled()
      })
      expect(promptIngestionChoices).not.toHaveBeenCalled()
      h.attachmentsState.getAttachments = vi.fn(() => [])
    })
  })

  it('invokes stop when ChatInput calls onStop', () => {
    renderComponent()
    screen.getByTestId('chat-stop').click()
    expect(h.mockStop).toHaveBeenCalled()
  })

  it('regenerate from a user message calls regenerate with its id', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-u1').click()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'u1' })
  })

  it('regenerate from an assistant message keeps the prior version (no delete)', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-a1').click()
    // Versioning: the old reply is preserved, parent links are backfilled.
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'a1' })
  })

  it('edit on a user message forks a new version and regenerates', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-u1').click()
    // A new sibling version is added; the original branch is not deleted.
    expect(h.messagesState.addMessage).toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: expect.any(String) })
    )
  })

  it('edit on an assistant message updates without regenerating', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-a1').click()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('shows a version chip and switches branches without regenerating', () => {
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
    ]
    renderComponent()
    // The active (newest) reply shows as version 2 of 2.
    expect(screen.getByTestId('version-a1b').textContent).toBe('2/2')
    screen.getByTestId('prev-a1b').click()
    // Switching pins the parent's active child and re-renders, no regeneration.
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('clears an active banner error when switching versions so a healthy assistant is not hidden', () => {
    // A prior turn left a router OOM banner active. Without clearing it on
    // switch, the render filter blanks the last assistant of whatever branch we
    // land on, leaving only user messages visible.
    h.modelProviderState.selectedProvider = 'llamacpp'
    h.appStateState.oomError = 'router crashed'
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    // a1b is rendered mid-list (a trailing user turn keeps it off the
    // last-message filter) so its version nav stays clickable.
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'more' }] },
    ]
    renderComponent()
    screen.getByTestId('prev-a1b').click()
    expect(h.appStateState.setOomError).toHaveBeenCalledWith(undefined)
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('onFinish links a new assistant to the active user turn in a branched thread (never null parent)', () => {
    // Regression for #8357: once a thread is branched, a lost pending-parent ref
    // must not persist the assistant with parentId:null (which computeActivePath
    // drops as a phantom root, leaving "user messages in a row").
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'r1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'u2',
        role: 'user',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'again', annotations: [] } }],
        metadata: { parentId: 'a1' },
      },
    ]
    h.messagesState.getMessages = vi.fn(() => branched)
    renderComponent()

    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'reply for u2' }],
          metadata: {},
        },
        isAbort: false,
      })
    })

    const added = h.messagesState.addMessage.mock.calls.map((c: any[]) => c[0])
    const persisted = added.find((m: any) => m.id === 'a2')
    expect(persisted).toBeTruthy()
    expect(persisted.metadata.parentId).toBe('u2')
    expect(persisted.metadata.parentId).not.toBeNull()
  })

  describe('finishReason length (#9228)', () => {
    const finishAtLength = () =>
      (h as any).capturedOnFinish({
        message: {
          id: 'a-len',
          role: 'assistant',
          parts: [{ type: 'text', text: 'partial answer' }],
          metadata: {
            finishReason: 'length',
            usage: { inputTokens: 30000, outputTokens: 4000 },
          },
        },
        isAbort: false,
        isError: false,
      })

    it('keeps a truncated cloud reply as stopped instead of a context banner', () => {
      h.modelProviderState.selectedProvider = 'anthropic'
      renderComponent()
      act(() => {
        finishAtLength()
      })
      const added = h.messagesState.addMessage.mock.calls.map((c: any[]) => c[0])
      const persisted = added.find((m: any) => m.id === 'a-len')
      expect(persisted).toBeTruthy()
      expect(persisted.metadata.stopped).toBe(true)
      expect(screen.queryByText('Increase Context Size')).toBeNull()
    })

    it('still offers Increase Context Size for a local model near ctx_len', () => {
      h.modelProviderState.selectedProvider = 'llamacpp'
      renderComponent()
      act(() => {
        finishAtLength()
      })
      expect(
        h.messagesState.addMessage.mock.calls.some((c: any[]) => c[0].id === 'a-len')
      ).toBe(false)
      expect(screen.getByText('Increase Context Size')).toBeInTheDocument()
    })
  })

  describe('empty replies (#9228)', () => {
    beforeEach(() => {
      useMessageErrors.getState().clearAll()
    })

    const finishEmpty = (extra: Record<string, unknown> = {}) =>
      (h as any).capturedOnFinish({
        message: {
          id: 'a-empty',
          role: 'assistant',
          parts: [],
          metadata: { finishReason: 'stop' },
        },
        isAbort: false,
        isError: false,
        ...extra,
      })

    it('pins the error on the user turn, which is persisted', () => {
      // The empty assistant reply is never saved, so an error keyed to it
      // would vanish on reload; the user message survives and is hydrated.
      renderComponent()
      act(() => {
        finishEmpty()
      })
      const err = useMessageErrors.getState().errors['u1']
      expect(err).toBeTruthy()
      expect(err).not.toContain(':')
      expect(useMessageErrors.getState().errors['a-empty']).toBeUndefined()
    })

    it('persists the empty-reply error into the user turn metadata', () => {
      const u1 = {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: {},
      }
      h.messagesState.messages = { 'thread-1': [u1] }
      h.messagesState.getMessages = vi.fn(() => [u1])
      renderComponent()
      act(() => {
        finishEmpty()
      })
      const persisted = h.messagesState.updateMessage.mock.calls
        .map((c: any[]) => c[0])
        .find((m: any) => m.id === 'u1' && m.metadata?.error)
      expect(persisted?.metadata.error).toBe(
        useMessageErrors.getState().errors['u1']
      )
    })

    it('does not flag a reply the user stopped', () => {
      renderComponent()
      act(() => {
        finishEmpty({ isAbort: true })
      })
      expect(useMessageErrors.getState().errors['a-empty']).toBeUndefined()
    })
  })

  describe('context overflow banner (#9228)', () => {
    it('does not offer a no-op Increase Context Size for a cloud overflow', () => {
      h.modelProviderState.selectedProvider = 'anthropic'
      h.chatState.status = 'error'
      h.chatState.error = new Error(
        'input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000'
      )
      h.chatState.messages = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ]
      renderComponent()
      expect(screen.getByText('Model ran out of context size')).toBeInTheDocument()
      expect(screen.queryByText('Increase Context Size')).toBeNull()
      // The provider's own text says what to cut; the generic string hid it.
      expect(
        screen.getByText(/188240 \+ 21333 > 200000/)
      ).toBeInTheDocument()
      // Regenerate would re-send the same oversized prompt.
      expect(screen.queryByText('Regenerate')).toBeNull()
    })

    it('offers Increase Context Size for a llamacpp overflow', () => {
      h.modelProviderState.selectedProvider = 'llamacpp'
      h.chatState.status = 'error'
      h.chatState.error = new Error(
        'request (518 tokens) exceeds the available context size (512 tokens)'
      )
      h.chatState.messages = [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      ]
      renderComponent()
      expect(screen.getByText('Increase Context Size')).toBeInTheDocument()
    })
  })

  describe('tool-call approval requested early, execution stays in onFinish', () => {
    const toolCall = (id: string) => ({
      toolCall: { toolCallId: id, toolName: 'fetch', input: { url: 'x' } },
    })
    const finishWithToolCalls = () =>
      (h as any).capturedOnFinish({
        message: {
          id: 'a-tc',
          role: 'assistant',
          parts: [{ type: 'text', text: '' }],
          metadata: { finishReason: 'tool-calls' },
        },
        isAbort: false,
      })

    it('requests approval as soon as a tool call arrives, before onFinish', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      expect((h as any).capturedOnToolCall).toBeTypeOf('function')

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc1'))
      })

      // Popup is requested purely from the tool-call arrival, decoupled from onFinish.
      expect(h.toolApprovalState.requestApproval).toHaveBeenCalledWith(
        'tc1',
        'fetch',
        'thread-1',
        undefined
      )
    })

    // The prompt offers to trust the whole server, so it needs to know which.
    it('passes the tool server along with the approval request', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.appStateState.tools = [{ name: 'fetch', server: 'fetch-server' }]
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc1'))
      })

      expect(h.toolApprovalState.requestApproval).toHaveBeenCalledWith(
        'tc1',
        'fetch',
        'thread-1',
        'fetch-server'
      )
    })

    it('does NOT execute the tool from onToolCall (execution deferred to onFinish)', async () => {
      // Executing during streaming lands addToolResult on an incomplete message,
      // which suppresses auto-resubmit and makes the model appear to "stop".
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc1'))
      })

      expect(h.mockAddToolOutput).not.toHaveBeenCalled()
    })

    it('executes approved tools in onFinish so the completed message can auto-resubmit', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc2'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      // Global setup mock resolves callTool to { error: '', content: [] }.
      expect(h.mockAddToolOutput).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tc2', tool: 'fetch' })
      )
    })

    it('reuses the early approval instead of prompting twice', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc4'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      expect(h.toolApprovalState.requestApproval).toHaveBeenCalledTimes(1)
    })

    // A tool result is injected into conversation history verbatim, so an
    // uncapped one can exhaust the context on its own (#8557). The budget the
    // model's own window affords is handed to the backend, which enforces it.
    it('caps the tool result against the active model context window', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
      hub.mcp = () => ({ callTool }) as never
      renderComponent()

      const onToolCall = (
        h as { capturedOnToolCall: (arg: unknown) => Promise<void> }
      ).capturedOnToolCall
      await act(async () => {
        await onToolCall(toolCall('tc5'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      const { maxOutputChars } = callTool.mock.calls[0][0]
      // 4096-token window in the harness: a fraction of it, not the whole thing.
      expect(maxOutputChars).toBeGreaterThan(0)
      expect(maxOutputChars).toBeLessThan(4096 * 3.5)
    })

    it('omits the cap when the model reports no context window', async () => {
      // Remote providers often don't; the user's configured ceiling then governs
      // alone rather than an invented budget silently clipping output.
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      const previousSettings = h.modelProviderState.selectedModel.settings
      h.modelProviderState.selectedModel.settings = {}
      const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
      hub.mcp = () => ({ callTool }) as never

      try {
        renderComponent()
        const onToolCall = (
          h as { capturedOnToolCall: (arg: unknown) => Promise<void> }
        ).capturedOnToolCall
        await act(async () => {
          await onToolCall(toolCall('tc6'))
        })
        await act(async () => {
          await finishWithToolCalls()
        })

        expect(callTool.mock.calls[0][0].maxOutputChars).toBeUndefined()
      } finally {
        h.modelProviderState.selectedModel.settings = previousSettings
      }
    })

    // A model can request several tools in one turn. They arrive together but
    // are executed one at a time, which is what the queue display depends on.
    describe('several tool calls in one turn', () => {
      const arrive = async (...ids: string[]) => {
        for (const id of ids) {
          await act(async () => {
            await (h as any).capturedOnToolCall(toolCall(id))
          })
        }
      }

      it('executes every call in the turn', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        renderComponent()
        await arrive('tcA', 'tcB', 'tcC')
        await act(async () => {
          await finishWithToolCalls()
        })

        const ids = h.mockAddToolOutput.mock.calls.map(
          (c: any[]) => c[0].toolCallId
        )
        expect(ids).toEqual(['tcA', 'tcB', 'tcC'])
      })

      it('runs them one at a time, not concurrently', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        const started: string[] = []
        let releaseFirst: (() => void) | undefined
        const callTool = vi.fn(({ arguments: args }: any) => {
          started.push(args.id)
          if (started.length === 1) {
            return new Promise((resolve) => {
              releaseFirst = () => resolve({ error: '', content: [] })
            })
          }
          return Promise.resolve({ error: '', content: [] })
        })
        hub.mcp = () => ({ callTool }) as never

        renderComponent()
        await act(async () => {
          await (h as any).capturedOnToolCall({
            toolCall: {
              toolCallId: 'tcA',
              toolName: 'fetch',
              input: { id: 'tcA' },
            },
          })
          await (h as any).capturedOnToolCall({
            toolCall: {
              toolCallId: 'tcB',
              toolName: 'fetch',
              input: { id: 'tcB' },
            },
          })
        })
        await act(async () => {
          await finishWithToolCalls()
        })

        // Second call must not have been dispatched while the first is pending.
        expect(started).toEqual(['tcA'])
        await act(async () => {
          releaseFirst?.()
        })
        expect(started).toEqual(['tcA', 'tcB'])
      })

      it('drains the runtime queue and times every call', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        renderComponent()
        await arrive('tcA', 'tcB')
        await act(async () => {
          await finishWithToolCalls()
        })

        const runtime = useToolCallRuntime.getState()
        expect(runtime.queue).toEqual([])
        for (const id of ['tcA', 'tcB']) {
          expect(runtime.timings[id]?.startedAt).toBeDefined()
          expect(runtime.timings[id]?.endedAt).toBeDefined()
        }
      })

      it('keeps going when one call is denied', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.toolApprovalState.requestApproval = vi.fn((id: string) =>
          Promise.resolve(id !== 'tcA')
        )
        renderComponent()
        await arrive('tcA', 'tcB')
        await act(async () => {
          await finishWithToolCalls()
        })

        const outputs = h.mockAddToolOutput.mock.calls.map((c: any[]) => c[0])
        expect(outputs[0]).toMatchObject({
          toolCallId: 'tcA',
          state: 'output-error',
        })
        expect(outputs[1]).toMatchObject({ toolCallId: 'tcB' })
        expect(outputs[1].state).not.toBe('output-error')
      })

      // A denied call never runs, so it has no duration -- but leaving it in
      // the queue would keep its card claiming it is waiting its turn.
      it('leaves nothing queued after a denied call', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(false)
        renderComponent()
        await arrive('tcA', 'tcB')
        await act(async () => {
          await finishWithToolCalls()
        })

        const runtime = useToolCallRuntime.getState()
        expect(runtime.queue).toEqual([])
        expect(runtime.timings['tcA']?.startedAt).toBeUndefined()
        expect(runtime.timings['tcA']?.endedAt).toBeDefined()
      })
    })

    // The tool loop runs after the stream ended (status 'ready'), so ChatInput
    // needs its own signal to offer the stop button, and stopping has to abort
    // the loop itself: the SDK's stop() only knows about the stream.
    describe('stopping a running tool loop', () => {
      const toolsRunningFlag = () =>
        screen.getByTestId('tools-running').textContent

      // Executor for tool `tcA` hangs until released; others return at once.
      const hangingExecutor = () => {
        const started: string[] = []
        const releases: Record<string, () => void> = {}
        const callTool = vi.fn(({ arguments: args }: any) => {
          started.push(args.id)
          if (args.id === 'tcA') {
            return new Promise((resolve) => {
              releases[args.id] = () => resolve({ error: '', content: [] })
            })
          }
          return Promise.resolve({ error: '', content: [] })
        })
        hub.mcp = () => ({ callTool }) as never
        return { started, releases }
      }

      // Every call hangs until the test releases it.
      const hangingAll = () => {
        const started: string[] = []
        const releases: Record<string, () => void> = {}
        const callTool = vi.fn(({ arguments: args }: any) => {
          started.push(args.id)
          return new Promise((resolve) => {
            releases[args.id] = () => resolve({ error: '', content: [] })
          })
        })
        hub.mcp = () => ({ callTool }) as never
        return { started, releases }
      }

      const arriveWithIds = async (...ids: string[]) => {
        for (const id of ids) {
          await act(async () => {
            await (h as any).capturedOnToolCall({
              toolCall: { toolCallId: id, toolName: 'fetch', input: { id } },
            })
          })
        }
      }

      it('reports the loop as running from its start until it drains', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        const { releases } = hangingExecutor()
        renderComponent()
        expect(toolsRunningFlag()).toBe('false')

        await arriveWithIds('tcA')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(toolsRunningFlag()).toBe('true')

        await act(async () => {
          releases.tcA()
        })
        expect(toolsRunningFlag()).toBe('false')
      })

      it('stops the loop: later calls do not run and approvals are released', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        const { started, releases } = hangingExecutor()
        renderComponent()
        await arriveWithIds('tcA', 'tcB')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(started).toEqual(['tcA'])
        expect(toolsRunningFlag()).toBe('true')

        await act(async () => {
          screen.getByTestId('chat-stop').click()
        })

        // The existing stream stop is still invoked, the thread's pending
        // approvals are released and the running state is cleared at once.
        expect(h.mockStop).toHaveBeenCalledTimes(1)
        expect(h.toolApprovalState.clearPendingForThread).toHaveBeenCalledWith(
          'thread-1'
        )
        expect(toolsRunningFlag()).toBe('false')

        // The in-flight call finishes afterwards; tcB must never start and
        // only gets the denied result.
        await act(async () => {
          releases.tcA()
        })
        expect(started).toEqual(['tcA'])
        expect(
          h.mockAddToolOutput.mock.calls
            .map((c: any[]) => c[0])
            .filter((o: any) => o.toolCallId === 'tcB')
        ).toEqual([
          {
            state: 'output-error',
            tool: 'fetch',
            toolCallId: 'tcB',
            errorText: 'Tool execution denied by user',
          },
        ])
        expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith(
          'thread-1',
          false
        )
        expect(toolsRunningFlag()).toBe('false')
      })

      it('a stop on the first call gives both queued calls the denied result and runs neither', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        const { started, releases } = hangingAll()
        renderComponent()
        await arriveWithIds('tcA', 'tcB', 'tcC')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(started).toEqual(['tcA'])

        await act(async () => {
          screen.getByTestId('chat-stop').click()
        })
        const denied = (id: string) => ({
          state: 'output-error',
          tool: 'fetch',
          toolCallId: id,
          errorText: 'Tool execution denied by user',
        })
        // At once, not only when the call in flight returns.
        expect(h.mockAddToolOutput.mock.calls).toEqual([
          [denied('tcB')],
          [denied('tcC')],
        ])

        await act(async () => {
          releases.tcA()
        })
        expect(started).toEqual(['tcA'])
        const outputs = h.mockAddToolOutput.mock.calls.map((c: any[]) => c[0])
        expect(outputs.filter((o: any) => o.toolCallId !== 'tcA')).toEqual([
          denied('tcB'),
          denied('tcC'),
        ])
        // The call in flight keeps its own result.
        expect(outputs.find((o: any) => o.toolCallId === 'tcA')).toEqual({
          tool: 'fetch',
          toolCallId: 'tcA',
          output: [],
        })
        expect(useToolCallRuntime.getState().queue).toEqual([])
      })

      // Evaluated while the stopped loop is still alive (its tool in flight):
      // that is when the SDK asks, once the tool's output lands.
      it('does not ask the model for a follow-up after the stop', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.lastAssistantComplete.mockImplementation(() => true)
        const { releases } = hangingExecutor()
        renderComponent()
        const sendWhen = (
          h as {
            capturedSendAutomaticallyWhen?: (arg: {
              messages: unknown[]
            }) => boolean
          }
        ).capturedSendAutomaticallyWhen!
        expect(sendWhen).toBeTypeOf('function')

        await arriveWithIds('tcA')
        await act(async () => {
          await finishWithToolCalls()
        })
        // Control: a live loop that was not stopped may resubmit.
        expect(sendWhen({ messages: [] })).toBe(true)

        await act(async () => {
          screen.getByTestId('chat-stop').click()
        })
        expect(sendWhen({ messages: [] })).toBe(false)

        await act(async () => {
          releases.tcA()
        })
        expect(sendWhen({ messages: [] })).toBe(false)
      })

      // The user stops loop A, sends again and loop B starts while A's tool
      // has not returned yet. A must not tear down what B now owns.
      describe('a stopped loop whose tool returns after the next loop started', () => {
        const busyFalseCalls = () =>
          h.appStateState.setThreadBusy.mock.calls.filter(
            (c: any[]) => c[0] === 'thread-1' && c[1] === false
          ).length

        const startAThenStopThenB = async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          h.lastAssistantComplete.mockImplementation(() => true)
          const ctl = hangingAll()
          renderComponent()
          const sendWhen = (
            h as {
              capturedSendAutomaticallyWhen: (arg: {
                messages: unknown[]
              }) => boolean
            }
          ).capturedSendAutomaticallyWhen
          const followUps: Array<[string, boolean]> = []
          h.mockAddToolOutput.mockImplementation((o: any) => {
            followUps.push([
              o.toolCallId,
              (
                h as {
                  capturedSendAutomaticallyWhen: (arg: {
                    messages: unknown[]
                  }) => boolean
                }
              ).capturedSendAutomaticallyWhen({ messages: [] }),
            ])
          })
          await arriveWithIds('tcA')
          await act(async () => {
            await finishWithToolCalls()
          })
          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })
          expect(toolsRunningFlag()).toBe('false')

          await arriveWithIds('tcC')
          await act(async () => {
            await finishWithToolCalls()
          })
          expect(ctl.started).toEqual(['tcA', 'tcC'])
          expect(toolsRunningFlag()).toBe('true')
          return { ...ctl, sendWhen, followUps }
        }

        it('leaves the newer loop running, resubmittable and stoppable', async () => {
          const { releases, sendWhen } = await startAThenStopThenB()
          const busyBefore = busyFalseCalls()

          await act(async () => {
            releases.tcA()
          })

          expect(toolsRunningFlag()).toBe('true')
          expect(sendWhen({ messages: [] })).toBe(true)
          expect(busyFalseCalls()).toBe(busyBefore)

          // The stop button still reaches loop B.
          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })
          expect(toolsRunningFlag()).toBe('false')
          expect(sendWhen({ messages: [] })).toBe(false)
          await act(async () => {
            releases.tcC()
          })
        })

        it('lets the newer loop finish and send its results on', async () => {
          const { releases, followUps } = await startAThenStopThenB()

          await act(async () => {
            releases.tcA()
          })
          expect(toolsRunningFlag()).toBe('true')

          await act(async () => {
            releases.tcC()
          })
          // B's result landed while B was still the live, unaborted loop.
          expect(followUps).toContainEqual(['tcC', true])
          expect(toolsRunningFlag()).toBe('false')
          expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith(
            'thread-1',
            false
          )
        })
      })

      // The thread's session data is shared by its consecutive turns, so a
      // stopped loop and the next turn meet in the same object.
      describe('consecutive turns on one thread', () => {
        const addedIds = () =>
          h.mockAddToolOutput.mock.calls.map((c: any[]) => c[0].toolCallId)

        it('a turn after a stop runs only its own calls, never the stopped one', async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          h.lastAssistantComplete.mockImplementation(() => true)
          const { started, releases } = hangingAll()
          const followUps: Array<[string, boolean]> = []
          h.mockAddToolOutput.mockImplementation((o: any) => {
            followUps.push([
              o.toolCallId,
              (h as any).capturedSendAutomaticallyWhen({ messages: [] }),
            ])
          })
          renderComponent()
          await arriveWithIds('tcA')
          await act(async () => {
            await finishWithToolCalls()
          })
          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })

          // Turn B arrives and finishes while A's tool is still in flight.
          await arriveWithIds('tcC')
          await act(async () => {
            await finishWithToolCalls()
          })
          await act(async () => {
            releases.tcA()
          })
          await act(async () => {
            releases.tcC?.()
          })

          expect(started).toEqual(['tcA', 'tcC'])
          expect(addedIds().filter((id: string) => id === 'tcA').length).toBe(1)
          expect(followUps).toContainEqual(['tcC', true])
          expect(toolsRunningFlag()).toBe('false')
          expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith(
            'thread-1',
            false
          )
        })

        it("a stopped tool that returns while the next turn streams leaves that turn's calls alone", async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          const { started, releases } = hangingAll()
          renderComponent()
          await arriveWithIds('tcA')
          await act(async () => {
            await finishWithToolCalls()
          })
          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })

          // B is streaming: its call has arrived, its finish has not.
          await arriveWithIds('tcC')
          await act(async () => {
            releases.tcA()
          })
          await act(async () => {
            await finishWithToolCalls()
          })
          expect(started).toEqual(['tcA', 'tcC'])
          expect(toolsRunningFlag()).toBe('true')

          await act(async () => {
            releases.tcC()
          })
          expect(addedIds()).toContain('tcC')
          expect(toolsRunningFlag()).toBe('false')
        })
      })

      // The route component is reused across threads; each thread keeps its
      // own loop state.
      it('a thread left mid-loop keeps nothing that blocks or reruns on return', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.threadsState.threads['thread-2'] = {
          id: 'thread-2',
          title: 'Other',
          metadata: {},
          assistants: [],
          model: { id: 'gpt-x', provider: 'openai' },
        }
        const { started, releases } = hangingAll()
        const Component = Route.component as React.ComponentType
        const { rerender } = render(<Component />)
        await arriveWithIds('tcA', 'tcB')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(started).toEqual(['tcA'])

        // Thread Y starts its own loop; X's stopped tool returns meanwhile.
        h.routeThreadId = 'thread-2'
        await act(async () => {
          rerender(<Component />)
        })
        // Leaving X stopped its loop: the call it had not reached is denied
        // (through X's own Chat, whose callbacks the loop holds).
        expect(h.mockAddToolOutput).toHaveBeenCalledWith({
          state: 'output-error',
          tool: 'fetch',
          toolCallId: 'tcB',
          errorText: 'Tool execution denied by user',
        })
        await arriveWithIds('tcY')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(started).toEqual(['tcA', 'tcY'])
        await act(async () => {
          releases.tcA()
        })

        h.messageQueueState.dequeue.mockClear()
        h.routeThreadId = 'thread-1'
        await act(async () => {
          rerender(<Component />)
        })
        expect(h.sessionDataByThread['thread-1'].tools).toEqual([])
        expect(toolsRunningFlag()).toBe('false')
        expect(h.messageQueueState.dequeue).toHaveBeenCalledWith('thread-1')

        // X's next turn runs its own call only.
        await arriveWithIds('tcX')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(started).toEqual(['tcA', 'tcY', 'tcX'])
        await act(async () => {
          releases.tcX?.()
          releases.tcY?.()
        })
        delete h.threadsState.threads['thread-2']
      })

      // Leaving a thread does not stop its stream; the turn finishes in the
      // background and its onFinish must still find every call it collected.
      it('a thread left while streaming runs all its calls when its stream finishes', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.chatState.status = 'streaming'
        h.threadsState.threads['thread-2'] = {
          id: 'thread-2',
          title: 'Other',
          metadata: {},
          assistants: [],
          model: { id: 'gpt-x', provider: 'openai' },
        }
        const started: string[] = []
        const callTool = vi.fn(({ arguments: args }: any) => {
          started.push(args.id)
          return Promise.resolve({ error: '', content: [] })
        })
        hub.mcp = () => ({ callTool }) as never
        const Component = Route.component as React.ComponentType
        const { rerender } = render(<Component />)
        // X's Chat keeps these callbacks while the route shows Y.
        const x = {
          onToolCall: (h as any).capturedOnToolCall,
          onFinish: (h as any).capturedOnFinish,
        }
        const arriveInX = async (id: string) => {
          await act(async () => {
            await x.onToolCall({
              toolCall: { toolCallId: id, toolName: 'fetch', input: { id } },
            })
          })
        }
        await arriveInX('tcA')

        h.routeThreadId = 'thread-2'
        await act(async () => {
          rerender(<Component />)
        })
        // Leaving X released its open approvals, as before.
        expect(h.toolApprovalState.clearPendingForThread).toHaveBeenCalledWith(
          'thread-1'
        )

        // X's stream goes on in the background and finishes.
        await arriveInX('tcB')
        await act(async () => {
          await x.onFinish({
            message: {
              id: 'a-x',
              role: 'assistant',
              parts: [{ type: 'text', text: '' }],
              metadata: { finishReason: 'tool-calls' },
            },
            isAbort: false,
          })
        })

        expect(started).toEqual(['tcA', 'tcB'])
        expect(
          h.mockAddToolOutput.mock.calls.map((c: any[]) => c[0].toolCallId)
        ).toEqual(['tcA', 'tcB'])
        // tcA's released approval is asked for again by the loop.
        expect(
          h.toolApprovalState.requestApproval.mock.calls.filter(
            (c: any[]) => c[0] === 'tcA'
          ).length
        ).toBe(2)
        delete h.threadsState.threads['thread-2']
      })

      // The Chat keeps the callbacks of the render that created it, also after
      // the route unmounts and mounts again (settings and back).
      it("a remounted route shows and stops a loop run by the first mount's callbacks", async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        h.lastAssistantComplete.mockImplementation(() => true)
        const { started, releases } = hangingAll()
        const first = renderComponent()
        const chat = {
          onToolCall: (h as any).capturedOnToolCall,
          onFinish: (h as any).capturedOnFinish,
          sendWhen: (h as any).capturedSendAutomaticallyWhen,
        }
        first.unmount()
        renderComponent()

        await act(async () => {
          for (const id of ['tcA', 'tcB']) {
            await chat.onToolCall({
              toolCall: { toolCallId: id, toolName: 'fetch', input: { id } },
            })
          }
        })
        await act(async () => {
          await chat.onFinish({
            message: {
              id: 'a-tc',
              role: 'assistant',
              parts: [{ type: 'text', text: '' }],
              metadata: { finishReason: 'tool-calls' },
            },
            isAbort: false,
          })
        })
        expect(started).toEqual(['tcA'])
        expect(toolsRunningFlag()).toBe('true')

        await act(async () => {
          screen.getByTestId('chat-stop').click()
        })
        expect(toolsRunningFlag()).toBe('false')
        expect(chat.sendWhen({ messages: [] })).toBe(false)
        await act(async () => {
          releases.tcA()
        })
        expect(started).toEqual(['tcA'])
      })

      // The real approval store, so that releasing an approval is exercised
      // end to end: the dialog entry goes away and the awaiting loop unblocks.
      describe('with the real approval store', () => {
        let actualStore: typeof import('@/hooks/useToolApprovalRequests')['useToolApprovalRequests']
        let saved: { request: unknown; clear: unknown }

        beforeEach(async () => {
          const actual = await vi.importActual<
            typeof import('@/hooks/useToolApprovalRequests')
          >('@/hooks/useToolApprovalRequests')
          actualStore = actual.useToolApprovalRequests
          actualStore.setState({ pending: {} })
          saved = {
            request: h.toolApprovalState.requestApproval,
            clear: h.toolApprovalState.clearPendingForThread,
          }
          h.toolApprovalState.requestApproval =
            actualStore.getState().requestApproval
          h.toolApprovalState.clearPendingForThread =
            actualStore.getState().clearPendingForThread
        })

        afterEach(() => {
          h.toolApprovalState.requestApproval = saved.request
          h.toolApprovalState.clearPendingForThread = saved.clear
          actualStore.setState({ pending: {} })
        })

        const callTool = () => {
          const fn = vi.fn().mockResolvedValue({ error: '', content: [] })
          hub.mcp = () => ({ callTool: fn }) as never
          return fn
        }
        const finishAborted = (toolParts: unknown[] = []) =>
          (h as any).capturedOnFinish({
            message: {
              id: 'a-tc',
              role: 'assistant',
              parts: [{ type: 'text', text: 'partial' }, ...toolParts],
              metadata: { finishReason: 'tool-calls' },
            },
            isAbort: true,
          })

        it('stop while awaiting an approval releases it, denies the call and ends the loop', async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          const call = callTool()
          renderComponent()
          await arriveWithIds('tcP')
          await act(async () => {
            await finishWithToolCalls()
          })
          expect(Object.keys(actualStore.getState().pending)).toEqual(['tcP'])
          expect(toolsRunningFlag()).toBe('true')

          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })

          expect(actualStore.getState().pending).toEqual({})
          expect(toolsRunningFlag()).toBe('false')
          // The existing wording for a call that was not approved is kept.
          expect(h.mockAddToolOutput).toHaveBeenCalledWith(
            expect.objectContaining({
              toolCallId: 'tcP',
              state: 'output-error',
              errorText: 'Tool execution denied by user',
            })
          )
          expect(call).not.toHaveBeenCalled()
          expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith(
            'thread-1',
            false
          )
        })

        it('one stop during streaming releases an open approval and the aborted finish starts no tool loop', async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          h.chatState.status = 'streaming'
          const call = callTool()
          renderComponent()
          await arriveWithIds('tcP')
          expect(Object.keys(actualStore.getState().pending)).toEqual(['tcP'])

          await act(async () => {
            screen.getByTestId('chat-stop').click()
          })
          expect(h.mockStop).toHaveBeenCalledTimes(1)
          expect(actualStore.getState().pending).toEqual({})

          // The SDK then reports the aborted stream; its message carries the
          // call the stop dropped from the collected list.
          await act(async () => {
            await finishAborted([
              {
                type: 'tool-fetch',
                toolCallId: 'tcP',
                state: 'input-available',
                input: { id: 'tcP' },
              },
            ])
          })
          expect(call).not.toHaveBeenCalled()
          expect(h.mockAddToolOutput.mock.calls).toEqual([
            [
              {
                state: 'output-error',
                tool: 'fetch',
                toolCallId: 'tcP',
                errorText: 'Tool execution denied by user',
              },
            ],
          ])
          // No second dialog was opened for the stopped turn.
          expect(actualStore.getState().pending).toEqual({})
          expect(toolsRunningFlag()).toBe('false')
          // No loop, so the thread was never marked busy for tools.
          expect(h.appStateState.setThreadBusy).not.toHaveBeenCalledWith(
            'thread-1',
            true
          )
        })

        it('an aborted finish runs none of its calls and gives them the denied result', async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          const call = callTool()
          renderComponent()
          await arriveWithIds('tcP')
          await act(async () => {
            await finishAborted()
          })
          expect(call).not.toHaveBeenCalled()
          // The same result a call gets when its approval is denied, so the
          // card does not keep showing the call as running.
          expect(h.mockAddToolOutput.mock.calls).toEqual([
            [
              {
                state: 'output-error',
                tool: 'fetch',
                toolCallId: 'tcP',
                errorText: 'Tool execution denied by user',
              },
            ],
          ])
          expect(actualStore.getState().pending).toEqual({})
          expect(h.sessionDataByThread['thread-1'].tools).toEqual([])
          expect(toolsRunningFlag()).toBe('false')
        })

        it('the router error stop also releases the approvals of the thread', async () => {
          h.appStateState.mcpToolNames = new Set(['fetch'])
          h.modelProviderState.selectedProvider = 'llamacpp'
          // 'submitted' rather than 'streaming', which would also fetch the
          // llamacpp context size through the extension manager.
          h.chatState.status = 'submitted'
          const call = callTool()
          const Component = Route.component as React.ComponentType
          const { rerender } = render(<Component />)
          await arriveWithIds('tcP')
          expect(Object.keys(actualStore.getState().pending)).toEqual(['tcP'])

          h.appStateState.backendError = 'router crashed'
          await act(async () => {
            rerender(<Component />)
          })
          expect(h.mockStop).toHaveBeenCalled()
          expect(actualStore.getState().pending).toEqual({})
          expect(h.sessionDataByThread['thread-1'].tools).toEqual([])
          expect(call).not.toHaveBeenCalled()
        })
      })

      it('releases the thread approvals when the thread is left mid-loop', async () => {
        h.appStateState.mcpToolNames = new Set(['fetch'])
        hangingExecutor()
        const { unmount } = renderComponent()
        await arriveWithIds('tcA')
        await act(async () => {
          await finishWithToolCalls()
        })
        expect(toolsRunningFlag()).toBe('true')
        unmount()
        expect(h.toolApprovalState.clearPendingForThread).toHaveBeenCalledWith(
          'thread-1'
        )
      })
    })

    it('marks the thread busy during onFinish execution and clears it when tools drain', async () => {
      h.appStateState.mcpToolNames = new Set(['fetch'])
      h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
      renderComponent()

      await act(async () => {
        await (h as any).capturedOnToolCall(toolCall('tc5'))
      })
      await act(async () => {
        await finishWithToolCalls()
      })

      expect(h.appStateState.setThreadBusy).toHaveBeenCalledWith('thread-1', true)
      expect(h.appStateState.setThreadBusy).toHaveBeenLastCalledWith('thread-1', false)
    })
  })

  it('delete removes message from store and chat list', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]
    renderComponent()
    screen.getByTestId('del-u1').click()
    expect(h.messagesState.deleteMessage).toHaveBeenCalledWith('thread-1', 'u1')
    expect(h.mockSetChatMessages).toHaveBeenCalled()
  })

  it('shows PromptProgress while status is submitted', () => {
    h.chatState.status = 'submitted'
    renderComponent()
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it('processes an initial message from sessionStorage on mount', async () => {
    sessionStorage.setItem(
      'initial-message-thread-1',
      JSON.stringify({ text: 'hello from storage' })
    )
    renderComponent()
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(sessionStorage.getItem('initial-message-thread-1')).toBeNull()
  })

  it('clears queue on unmount', () => {
    const { unmount } = renderComponent()
    unmount()
    expect(h.messageQueueState.clearQueue).toHaveBeenCalledWith('thread-1')
  })

  it('updates RAG tool availability based on thread/model capabilities', async () => {
    renderComponent()
    await waitFor(() => {
      expect(h.mockUpdateRag).toHaveBeenCalled()
    })
    const args = h.mockUpdateRag.mock.calls[0]
    expect(args[1]).toBe(true) // modelSupportsTools
    expect(args[2]).toBe(true) // ragFeatureAvailable
  })
})
