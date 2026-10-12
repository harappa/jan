/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

  const chatSessionsState: any = {
    sessions: {},
    getSessionData: vi.fn(() => ({ tools: [] })),
  }
  const useChatSessionsMock: any = (selector: any) => selector(chatSessionsState)
  useChatSessionsMock.getState = () => chatSessionsState

  const attachmentsState: any = {
    getAttachments: vi.fn(() => []),
    clearAttachments: vi.fn(),
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

  const toolApprovalState: any = {
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
  useParams: () => ({ threadId: py.routeThreadId }),
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
  default: ({ onSubmit, onStop, chatStatus }: any) => (
    <div data-testid="chat-input">
      <span data-testid="chat-status">{chatStatus}</span>
      <button
        data-testid="chat-send"
        onClick={() => onSubmit('hello world', undefined)}
      >
        send
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

const py = vi.hoisted(() => ({
  executePython: vi.fn(),
  collectPythonAttachments: vi.fn(),
  getPythonStatus: vi.fn(),
  routeThreadId: 'thread-1',
}))

vi.mock('@/lib/pythonTool', () => ({
  PYTHON_TOOL_NAME: 'python',
  executePython: py.executePython,
  getPythonStatus: py.getPythonStatus,
}))

vi.mock('@/lib/pythonAttachments', () => ({
  collectPythonAttachments: py.collectPythonAttachments,
}))

const agent = vi.hoisted(() => ({ executeAgentTool: vi.fn() }))

vi.mock('@/lib/agentTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agentTools')>()),
  executeAgentTool: agent.executeAgentTool,
}))

vi.mock('@/lib/attachmentProcessing', () => ({
  processAttachmentsForSend: vi
    .fn()
    .mockResolvedValue({ processedAttachments: [], hasEmbeddedDocuments: false }),
  resolveAutoInlineBudget: vi.fn().mockResolvedValue(6144),
}))

vi.mock('@/lib/thread-title-summarizer', () => ({
  generateThreadTitle: vi.fn().mockResolvedValue('Short title'),
}))

vi.mock('@/types/attachment', () => ({
  createImageAttachment: (x: any) => ({ type: 'image', ...x }),
}))

vi.mock('ai', () => ({
  generateId: () => 'gen-id',
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (_args: any) => {
    ;(h as any).capturedOnFinish = _args?.onFinish
    ;(h as any).capturedOnToolCall = _args?.onToolCall
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
import { useMessageErrors } from '@/stores/message-errors'
import {
  processAttachmentsForSend,
  resolveAutoInlineBudget,
} from '@/lib/attachmentProcessing'

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
    h.chatSessionsState.getSessionData = vi.fn(() => ({ tools: [] }))
    h.messageQueueState.dequeue = vi.fn(() => null)
    h.messageQueueState.clearQueue = vi.fn()
    h.agentModeState.agentThreads = {}
    h.modelProviderState.selectedProvider = 'openai'
    h.appStateState.oomError = undefined
    h.appStateState.ragToolNames = new Set<string>()
    h.appStateState.mcpToolNames = new Set<string>()
    h.appStateState.tools = []
    h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(true)
    hub.mcp = realMcp
    py.executePython.mockReset()
    py.executePython.mockResolvedValue({
      content: 'ok\n[exit 0]',
      isError: false,
    })
    py.getPythonStatus.mockReset()
    py.getPythonStatus.mockResolvedValue({ available: true })
    py.routeThreadId = 'thread-1'
    py.collectPythonAttachments.mockReset()
    py.collectPythonAttachments.mockResolvedValue([])
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
    h.attachmentsState.getAttachments = vi.fn(() => [])
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

    // Chat no longer offers the built-in shell, so a call named shell can only
    // be an MCP server's tool: it must ask for approval and go to that server,
    // never to the sandboxed built-in (the same rule as python above).
    describe('a tool named shell', () => {
      const shellCall = (id: string, input: unknown) => ({
        toolCall: { toolCallId: id, toolName: 'shell', input },
      })
      const run = async (id: string, input: unknown) => {
        renderComponent()
        await act(async () => {
          await (h as any).capturedOnToolCall(shellCall(id, input))
        })
        await act(async () => {
          await finishWithToolCalls()
        })
      }

      beforeEach(() => {
        agent.executeAgentTool.mockReset().mockResolvedValue({ content: [] })
        h.appStateState.mcpToolNames = new Set(['shell'])
      })

      it('asks for approval like any other tool', async () => {
        await run('sh1', { command: 'echo 1' })

        expect(h.toolApprovalState.requestApproval).toHaveBeenCalledWith(
          'sh1',
          'shell',
          'thread-1',
          undefined
        )
      })

      it('routes the call to the MCP tool, not the built-in shell', async () => {
        const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
        hub.mcp = () => ({ callTool }) as never

        await run('sh2', { command: 'echo 1' })

        expect(callTool).toHaveBeenCalledWith(
          expect.objectContaining({
            toolName: 'shell',
            arguments: { command: 'echo 1' },
          })
        )
        expect(agent.executeAgentTool).not.toHaveBeenCalled()
      })

      it('does not run it when the approval is denied', async () => {
        h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(false)
        const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
        hub.mcp = () => ({ callTool }) as never

        await run('sh3', { command: 'echo 1' })

        expect(callTool).not.toHaveBeenCalled()
        expect(agent.executeAgentTool).not.toHaveBeenCalled()
        expect(h.mockAddToolOutput).toHaveBeenCalledWith(
          expect.objectContaining({ toolCallId: 'sh3', state: 'output-error' })
        )
      })
    })

    describe('python tool', () => {
      const pythonCall = (id: string, input: unknown) => ({
        toolCall: { toolCallId: id, toolName: 'python', input },
      })
      const run = async (id: string, input: unknown) => {
        renderComponent()
        await act(async () => {
          await (h as any).capturedOnToolCall(pythonCall(id, input))
        })
        await act(async () => {
          await finishWithToolCalls()
        })
      }

      it('runs without asking for approval', async () => {
        await run('py1', { code: 'print(1)' })

        expect(h.toolApprovalState.requestApproval).not.toHaveBeenCalled()
        expect(py.executePython).toHaveBeenCalledTimes(1)
      })

      it('runs the code with the thread id and the timeout', async () => {
        await run('py2', { code: 'print(1)', timeout: 60 })

        expect(py.executePython).toHaveBeenCalledWith(
          'thread-1',
          { code: 'print(1)', timeout: 60 },
          []
        )
      })

      it('passes the attachments collected from the chat messages', async () => {
        const attachments = [{ name: 'a.pdf', path: '/data/a.pdf' }]
        py.collectPythonAttachments.mockResolvedValue(attachments)
        h.chatState.messages = [
          { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        ]

        await run('py3', { code: 'print(1)' })

        expect(py.collectPythonAttachments).toHaveBeenCalledWith(
          'thread-1',
          h.chatState.messages
        )
        expect(py.executePython.mock.calls[0][2]).toBe(attachments)
      })

      it('gives the result to the model as the tool output', async () => {
        py.executePython.mockResolvedValue({
          content: '42\n[exit 0]',
          isError: false,
        })

        await run('py4', { code: 'print(42)' })

        expect(h.mockAddToolOutput).toHaveBeenCalledWith({
          tool: 'python',
          toolCallId: 'py4',
          output: '42\n[exit 0]',
        })
      })

      // The model has to read the traceback to fix its code, so a failed run
      // is an output, not an errorText.
      it('gives a failed run to the model as output too', async () => {
        py.executePython.mockResolvedValue({
          content: 'Traceback\nNameError: x\n[exit 1]',
          isError: true,
        })

        await run('py5', { code: 'x' })

        expect(h.mockAddToolOutput).toHaveBeenCalledTimes(1)
        const call = h.mockAddToolOutput.mock.calls[0][0]
        expect(call).toEqual({
          tool: 'python',
          toolCallId: 'py5',
          output: 'Traceback\nNameError: x\n[exit 1]',
        })
        expect(call).not.toHaveProperty('errorText')
        expect(call).not.toHaveProperty('state')
      })

      it.each([
        ['missing', {}],
        ['not a string', { code: 5 }],
        ['no input', undefined],
      ])('answers ERROR without running: code is %s', async (_n, input) => {
        await run('py6', input)

        expect(py.executePython).not.toHaveBeenCalled()
        expect(h.mockAddToolOutput).toHaveBeenCalledTimes(1)
        const call = h.mockAddToolOutput.mock.calls[0][0]
        expect(call.toolCallId).toBe('py6')
        expect(call.output).toMatch(/^ERROR: /)
        expect(call).not.toHaveProperty('errorText')
      })

      it('uses the id of the thread the route shows', async () => {
        py.routeThreadId = 'thread-2'
        h.threadsState.threads['thread-2'] = {
          ...h.threadsState.threads['thread-1'],
          id: 'thread-2',
        }

        await run('py9', { code: 'print(1)' })

        expect(py.collectPythonAttachments).toHaveBeenCalledWith(
          'thread-2',
          expect.anything()
        )
        expect(py.executePython.mock.calls[0][0]).toBe('thread-2')
      })

      // The transport offers the built-in only when python is available; then
      // a tool named python belongs to someone else (an MCP server) and must
      // not skip approval or be routed to the sandbox.
      describe('when python is unavailable', () => {
        beforeEach(() => {
          py.getPythonStatus.mockResolvedValue({ available: false })
          h.appStateState.mcpToolNames = new Set(['python'])
        })

        it('asks for approval like any other tool', async () => {
          await run('py10', { code: 'print(1)' })

          expect(h.toolApprovalState.requestApproval).toHaveBeenCalledWith(
            'py10',
            'python',
            'thread-1',
            undefined
          )
        })

        it('routes the call to the MCP tool, not the sandbox', async () => {
          const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
          hub.mcp = () => ({ callTool }) as never

          await run('py11', { code: 'print(1)' })

          expect(callTool).toHaveBeenCalledWith(
            expect.objectContaining({
              toolName: 'python',
              arguments: { code: 'print(1)' },
            })
          )
          expect(py.executePython).not.toHaveBeenCalled()
          expect(py.collectPythonAttachments).not.toHaveBeenCalled()
        })

        it('does not run it when the approval is denied', async () => {
          h.toolApprovalState.requestApproval = vi.fn().mockResolvedValue(false)
          const callTool = vi.fn().mockResolvedValue({ error: '', content: [] })
          hub.mcp = () => ({ callTool }) as never

          await run('py12', { code: 'print(1)' })

          expect(callTool).not.toHaveBeenCalled()
          expect(py.executePython).not.toHaveBeenCalled()
          expect(h.mockAddToolOutput).toHaveBeenCalledWith(
            expect.objectContaining({
              toolCallId: 'py12',
              state: 'output-error',
            })
          )
        })
      })

      it('answers an ERROR output when running throws', async () => {
        py.executePython.mockRejectedValue(new Error('boom'))

        await run('py7', { code: 'print(1)' })

        expect(h.mockAddToolOutput).toHaveBeenCalledWith({
          tool: 'python',
          toolCallId: 'py7',
          output: 'ERROR: boom',
        })
      })

      it('answers an ERROR output when the attachments cannot be collected', async () => {
        py.collectPythonAttachments.mockRejectedValue(new Error('no list'))

        await run('py8', { code: 'print(1)' })

        expect(py.executePython).not.toHaveBeenCalled()
        expect(h.mockAddToolOutput).toHaveBeenCalledWith({
          tool: 'python',
          toolCallId: 'py8',
          output: 'ERROR: no list',
        })
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
