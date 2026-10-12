import { useEffect, useState } from 'react'
import { getPythonStatus } from '@/lib/pythonTool'

/**
 * Whether the built-in python tool is available here: the cached answer the
 * transport and the thread route act on. `active` lets a caller that only
 * sometimes cares (a card for a tool that is not `python`) skip the lookup.
 *
 * It starts as `true` and settles on the real answer a moment later. A run of
 * the built-in therefore never shows as a generic card first; the one case that
 * changes is a machine without the sandbox that has an MCP tool of the same
 * name, which flips to the MCP card after the lookup.
 */
export const usePythonAvailable = (active = true): boolean => {
  const [available, setAvailable] = useState(true)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void getPythonStatus().then((status) => {
      if (!cancelled) setAvailable(status.available)
    })
    return () => {
      cancelled = true
    }
  }, [active])

  return available
}
