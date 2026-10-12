import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  endToolLoop,
  markToolCallReached,
  startToolLoop,
  stopToolLoop,
  toolApprovalsFor,
  useToolLoops,
} from '../tool-loop-store'
import { useChatSessions } from '../chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'

const data = (threadId: string) =>
  useChatSessions.getState().getSessionData(threadId)
const peek = (threadId: string) =>
  useChatSessions.getState().peekSessionData(threadId)
const running = (threadId: string) =>
  !!useToolLoops.getState().running[threadId]
const busy = (threadId: string) =>
  !!useAppState.getState().busyThreads[threadId]
const call = (id: string) => ({ toolCallId: id, toolName: 'fetch', input: {} })
const noDeny = () => {}

beforeEach(() => {
  useChatSessions.getState().clearSessions()
  useToolLoops.setState({ running: {} })
  useAppState.setState({ busyThreads: {} })
  useToolApprovalRequests.setState({ pending: {} })
  useToolCallRuntime.getState().reset()
})

describe('startToolLoop', () => {
  it('takes the collected calls, so calls arriving later start a new list', () => {
    data('t1').tools.push(call('a'), call('b'))
    const { loop, toolCalls } = startToolLoop('t1', noDeny)

    expect(toolCalls.map((c) => c.toolCallId)).toEqual(['a', 'b'])
    expect(loop.toolCallIds).toEqual(['a', 'b'])
    expect(data('t1').tools).toEqual([])
    expect(data('t1').toolLoop).toBe(loop)
    expect(running('t1')).toBe(true)
    expect(busy('t1')).toBe(true)
  })
})

describe('endToolLoop', () => {
  it('clears the thread state when the loop still owns it', () => {
    const { loop } = startToolLoop('t1', noDeny)
    endToolLoop('t1', loop)

    expect(data('t1').toolLoop).toBeUndefined()
    expect(running('t1')).toBe(false)
    expect(busy('t1')).toBe(false)
  })

  it('leaves a newer loop and the calls collected since alone', () => {
    data('t1').tools.push(call('a'))
    const { loop: first } = startToolLoop('t1', noDeny)
    stopToolLoop('t1')
    data('t1').tools.push(call('c'))
    const pendingC = Promise.resolve(true)
    toolApprovalsFor('t1').set('c', pendingC)
    const { loop: second } = startToolLoop('t1', noDeny)
    data('t1').tools.push(call('d'))

    endToolLoop('t1', first)

    expect(data('t1').toolLoop).toBe(second)
    expect(running('t1')).toBe(true)
    expect(busy('t1')).toBe(true)
    expect(data('t1').tools.map((c) => c.toolCallId)).toEqual(['d'])
    expect(toolApprovalsFor('t1').get('c')).toBe(pendingC)
  })

  it('settles only its own calls, keeping the end time of finished ones', () => {
    data('t1').tools.push(call('a'), call('b'))
    const { loop } = startToolLoop('t1', noDeny)
    const runtime = useToolCallRuntime.getState()
    runtime.enqueue(['a', 'b'])
    runtime.markRunning('a')
    runtime.markSettled('a')
    const endedA = useToolCallRuntime.getState().timings.a.endedAt
    useToolCallRuntime.getState().enqueue(['x'])

    endToolLoop('t1', loop)

    const { timings } = useToolCallRuntime.getState()
    expect(timings.a.endedAt).toBe(endedA)
    expect(timings.b.endedAt).toBeDefined()
    expect(timings.x.endedAt).toBeUndefined()
    expect(useToolCallRuntime.getState().queue).toEqual(['x'])
  })

  it('drops the approval promises of its own calls only', () => {
    data('t1').tools.push(call('a'))
    toolApprovalsFor('t1').set('a', Promise.resolve(true))
    const { loop } = startToolLoop('t1', noDeny)
    toolApprovalsFor('t1').set('c', Promise.resolve(true))

    endToolLoop('t1', loop)

    expect([...toolApprovalsFor('t1').keys()]).toEqual(['c'])
  })
})

describe('stopToolLoop', () => {
  it('aborts the loop and releases everything the thread holds', async () => {
    data('t1').tools.push(call('a'), call('b'))
    const { loop } = startToolLoop('t1', noDeny)
    useToolCallRuntime.getState().enqueue(['a', 'b'])
    markToolCallReached(loop, 'a')
    useToolCallRuntime.getState().markRunning('a')
    data('t1').tools.push(call('c'))
    toolApprovalsFor('t1').set('c', Promise.resolve(true))
    const approval = useToolApprovalRequests
      .getState()
      .requestApproval('c', 'fetch', 't1')

    stopToolLoop('t1')

    expect(loop.controller.signal.aborted).toBe(true)
    expect(data('t1').toolLoop).toBeUndefined()
    expect(data('t1').tools).toEqual([])
    expect(toolApprovalsFor('t1').size).toBe(0)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
    await expect(approval).resolves.toBe(false)
    expect(running('t1')).toBe(false)
    expect(busy('t1')).toBe(false)
    // Calls the loop never reached stop waiting; the one in flight keeps
    // timing until its executor returns.
    const { timings, queue } = useToolCallRuntime.getState()
    expect(queue).toEqual([])
    expect(timings.b.endedAt).toBeDefined()
    expect(timings.a.endedAt).toBeUndefined()
  })

  it('gives the calls the loop has not reached the denied result, once', () => {
    data('t1').tools.push(call('a'), call('b'), call('c'))
    const deny = vi.fn()
    const { loop } = startToolLoop('t1', deny)
    markToolCallReached(loop, 'a')

    stopToolLoop('t1')
    stopToolLoop('t1')

    expect(deny.mock.calls).toEqual([
      [{ toolCallId: 'b', toolName: 'fetch' }],
      [{ toolCallId: 'c', toolName: 'fetch' }],
    ])
  })

  it('does not clear a busy mark it does not own', () => {
    // Attachments being embedded mark the thread busy without a tool loop.
    useAppState.getState().setThreadBusy('t1', true)
    stopToolLoop('t1')
    expect(busy('t1')).toBe(true)
  })

  it('keeps the calls of a turn still streaming when asked to', () => {
    data('t1').tools.push(call('a'))
    const { loop } = startToolLoop('t1', noDeny)
    data('t1').tools.push(call('s'))

    stopToolLoop('t1', { keepCollected: true })

    expect(loop.controller.signal.aborted).toBe(true)
    expect(data('t1').toolLoop).toBeUndefined()
    expect(data('t1').tools.map((c) => c.toolCallId)).toEqual(['s'])
    expect(running('t1')).toBe(false)
  })

  it('touches no other thread', () => {
    data('t2').tools.push(call('z'))
    const { loop } = startToolLoop('t2', noDeny)
    stopToolLoop('t1')
    expect(loop.controller.signal.aborted).toBe(false)
    expect(running('t2')).toBe(true)
  })
})

describe('a deleted thread', () => {
  const withSession = (threadId: string) => {
    const chat = { status: 'ready', messages: [], stop: vi.fn() }
    useChatSessions
      .getState()
      .ensureSession(threadId, {} as never, () => chat as never)
    return chat
  }

  it('has its loop stopped and its approvals released by removeSession', async () => {
    withSession('t1')
    data('t1').tools.push(call('a'), call('b'))
    const deny = vi.fn()
    const { loop } = startToolLoop('t1', deny)
    markToolCallReached(loop, 'a')
    const approval = useToolApprovalRequests
      .getState()
      .requestApproval('a', 'fetch', 't1')

    useChatSessions.getState().removeSession('t1')

    expect(loop.controller.signal.aborted).toBe(true)
    expect(deny).toHaveBeenCalledWith({ toolCallId: 'b', toolName: 'fetch' })
    await expect(approval).resolves.toBe(false)
    expect(useToolApprovalRequests.getState().pending).toEqual({})
    expect(running('t1')).toBe(false)
    expect(busy('t1')).toBe(false)
  })

  it('leaves no data behind when its loop ends or is stopped later', () => {
    withSession('t1')
    data('t1').tools.push(call('a'))
    const { loop } = startToolLoop('t1', noDeny)
    useChatSessions.getState().removeSession('t1')
    expect(peek('t1')).toBeUndefined()

    endToolLoop('t1', loop)
    stopToolLoop('t1')
    stopToolLoop('t1', { keepCollected: true })

    expect(peek('t1')).toBeUndefined()
  })
})
