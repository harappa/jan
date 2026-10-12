import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

const getPythonStatus = vi.hoisted(() => vi.fn())
vi.mock('@/lib/pythonTool', () => ({ getPythonStatus }))

import { usePythonAvailable } from '../usePythonAvailable'

describe('usePythonAvailable', () => {
  // A running built-in call must not show as a generic card while the status
  // is being read.
  it('assumes available until the status arrives, then follows it', async () => {
    getPythonStatus.mockResolvedValue({ available: false })
    const { result } = renderHook(() => usePythonAvailable())
    expect(result.current).toBe(true)
    await waitFor(() => expect(result.current).toBe(false))
  })

  it('does not ask when the caller does not care', () => {
    getPythonStatus.mockClear()
    renderHook(() => usePythonAvailable(false))
    expect(getPythonStatus).not.toHaveBeenCalled()
  })
})
