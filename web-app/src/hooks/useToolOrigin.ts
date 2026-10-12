import { useMemo } from 'react'
import { useAppState } from '@/hooks/useAppState'
import { getProviderMeta, useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { resolveToolOrigin, type ToolOrigin } from '@/lib/toolOrigin'
import { AGENT_TOOL_NAMES, isRecordedShellCall } from '@/lib/agentTools'
import { PYTHON_TOOL_NAME } from '@/lib/pythonTool'
import { usePythonAvailable } from '@/hooks/usePythonAvailable'

/**
 * Resolve which family a tool call belongs to. Each selector returns a
 * primitive so a refreshed-but-equivalent tool list does not re-render every
 * card on screen.
 */
export const useToolOrigin = (toolName: string): ToolOrigin | undefined => {
  const mcpServer = useAppState(
    (s) => s.tools.find((tool) => tool.name === toolName)?.server
  )
  const isRagTool = useAppState((s) => s.ragToolNames.has(toolName))
  // When the built-in python is available the transport offers it in place of
  // an MCP tool of the same name and runs it, so that is what a call means.
  // Without it, such a tool belongs to its server; with no server either, the
  // call is an old one and stays readable as the built-in's card.
  const isPython = toolName === PYTHON_TOOL_NAME
  const pythonAvailable = usePythonAvailable(isPython)
  const isAgentTool =
    AGENT_TOOL_NAMES.has(toolName) ||
    isRecordedShellCall(toolName) ||
    (isPython && (pythonAvailable || mcpServer === undefined))
  const webSearchProviderLabel = useWebSearchConfig(
    (s) => getProviderMeta(s.searchProvider).label
  )

  return useMemo(
    () =>
      resolveToolOrigin(toolName, {
        mcpServer,
        isRagTool,
        isAgentTool,
        webSearchProviderLabel,
      }),
    [toolName, mcpServer, isRagTool, isAgentTool, webSearchProviderLabel]
  )
}
