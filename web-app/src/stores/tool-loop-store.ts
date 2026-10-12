import { create } from 'zustand'
import {
  useChatSessions,
  type ToolCallRef,
  type ToolLoop,
} from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useToolCallRuntime } from '@/hooks/useToolCallRuntime'

/**
 * Chat tool loops, one per thread. The loop runs in useChat's onFinish, after
 * the stream ended, so the SDK status is 'ready' meanwhile and cannot tell the
 * chat input to offer the stop button.
 *
 * The loop itself lives in the thread's session data, not in the chat route:
 * the Chat keeps the callbacks of the render that created it, so after the
 * route remounts a loop is started by the old component's closures while the
 * new component has to show and stop it.
 */
type ToolLoopsState = {
  running: Record<string, true>
  setRunning: (threadId: string, running: boolean) => void
}

export const useToolLoops = create<ToolLoopsState>()((set) => ({
  running: {},
  setRunning: (threadId, running) =>
    set((s) => {
      if (!!s.running[threadId] === running) return s
      const next = { ...s.running }
      if (running) next[threadId] = true
      else delete next[threadId]
      return { running: next }
    }),
}))

const sessionData = (threadId: string) =>
  useChatSessions.getState().getSessionData(threadId)

/** The thread's approval promises, shared by onToolCall and the loop. */
export function toolApprovalsFor(
  threadId: string
): Map<string, Promise<boolean>> {
  const data = sessionData(threadId)
  data.toolApprovals ??= new Map()
  return data.toolApprovals
}

/**
 * Starts the thread's loop over the calls collected so far. They move to the
 * loop: calls of a later turn are collected in a fresh list, so a stopped loop
 * and the next turn never share one. `deny` gives a call the denied result; a
 * stop uses it for the calls the loop has not reached.
 */
export function startToolLoop(
  threadId: string,
  deny: (toolCall: ToolCallRef) => void
) {
  const data = sessionData(threadId)
  const toolCalls = data.tools
  data.tools = []
  const loop: ToolLoop = {
    controller: new AbortController(),
    toolCallIds: toolCalls.map((tc) => tc.toolCallId),
    unreached: toolCalls.map((tc) => ({
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
    })),
    deny,
  }
  data.toolLoop = loop
  useToolLoops.getState().setRunning(threadId, true)
  // Keep the thread busy while awaiting approval and executing tools, since
  // streaming has already ended.
  useAppState.getState().setThreadBusy(threadId, true)
  return { loop, toolCalls }
}

/** The loop has reached this call: from here on the loop gives its result. */
export function markToolCallReached(loop: ToolLoop, toolCallId: string) {
  loop.unreached = loop.unreached.filter((tc) => tc.toolCallId !== toolCallId)
}

/** Ends calls of `ids` that have not ended, optionally only unstarted ones. */
function settleCalls(ids: string[], unstartedOnly: boolean) {
  for (const id of ids) {
    const timing = useToolCallRuntime.getState().timings[id]
    if (!timing || timing.endedAt !== undefined) continue
    if (unstartedOnly && timing.startedAt !== undefined) continue
    useToolCallRuntime.getState().markSettled(id)
  }
}

/**
 * Exit of a loop, however it ended. Only its own calls are settled and
 * forgotten; the thread state is cleared only while this loop still owns it,
 * since a stopped loop can return after the next one started.
 */
export function endToolLoop(threadId: string, loop: ToolLoop) {
  const data = sessionData(threadId)
  if (data.toolLoop === loop) {
    data.toolLoop = undefined
    useToolLoops.getState().setRunning(threadId, false)
    useAppState.getState().setThreadBusy(threadId, false)
  }
  settleCalls(loop.toolCallIds, false)
  for (const id of loop.toolCallIds) data.toolApprovals?.delete(id)
}

/** Releases the approvals waiting on the thread, resolving them as denied. */
export function releaseToolApprovals(threadId: string) {
  sessionData(threadId).toolApprovals?.clear()
  useToolApprovalRequests.getState().clearPendingForThread(threadId)
}

/**
 * Stops whatever the thread's tools are doing: aborts its loop (an aborted
 * loop runs no further call and asks for no follow-up), gives the calls it has
 * not reached the denied result so their cards do not keep showing them as
 * running, releases its approvals and drops the calls collected for the turn
 * being stopped, so they never run later. Safe to call when nothing runs.
 *
 * The denied results go to the thread's own Chat (the loop's callbacks belong
 * to it), so this is safe also for a thread the route has just left.
 */
export function stopToolLoop(threadId: string) {
  const data = sessionData(threadId)
  const loop = data.toolLoop
  data.toolLoop = undefined
  data.tools = []
  if (loop) {
    loop.controller.abort()
    const unreached = loop.unreached
    loop.unreached = []
    for (const toolCall of unreached) loop.deny(toolCall)
    // The call in flight keeps timing until its executor returns.
    settleCalls(loop.toolCallIds, true)
    // Only the loop's own busy mark: embedding attachments sets one too.
    useAppState.getState().setThreadBusy(threadId, false)
  }
  useToolLoops.getState().setRunning(threadId, false)
  releaseToolApprovals(threadId)
}
