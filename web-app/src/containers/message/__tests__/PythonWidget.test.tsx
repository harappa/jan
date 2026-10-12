import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

// Keys come back with their arguments, so a test can tell which text a
// placeholder was filled with without loading the locale files.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: (s: unknown) => unknown) =>
    selector({ currentThreadId: 'thread-1' }),
}))

const hoisted = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
  savePythonFile: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('@/lib/pythonTool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pythonTool')>()),
  savePythonFile: hoisted.savePythonFile,
}))

import { PythonWidget } from '../PythonWidget'

const bar = { variant: 'python', code: 'print(6 * 7)' } as const

const renderDone = (output: string, code = bar.code) =>
  render(
    <PythonWidget
      bar={{ variant: 'python', code }}
      state="output-available"
      output={output}
    />
  )

const fileResult = [
  'done',
  '[exit 0]',
  '[file: out/report.csv (1536 bytes)]',
  '[file: notes.txt (12 bytes)]',
].join('\n')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('PythonWidget', () => {
  it('shows the code, the output and the exit status', () => {
    renderDone('42\n[exit 0]')
    expect(screen.getByText('print(6 * 7)')).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
    expect(screen.getByText('tools:python.title')).toBeInTheDocument()
    expect(
      screen.getByText('tools:toolCall.exitCode {"code":0}')
    ).toBeInTheDocument()
    expect(screen.queryByText('tools:python.files')).not.toBeInTheDocument()
  })

  it('marks a failed run', () => {
    renderDone('Traceback\nValueError: x\n[exit 1]')
    expect(screen.getByText(/ValueError: x/)).toBeInTheDocument()
    expect(screen.getByText('tools:toolCall.exitCode {"code":1}')).toHaveClass(
      'text-destructive'
    )
    expect(screen.getByTestId('python-status-error')).toBeInTheDocument()
  })

  it('does not mark a clean run as an error', () => {
    renderDone('42\n[exit 0]')
    expect(screen.queryByTestId('python-status-error')).toBeNull()
  })

  it('shows the code and a running state, with no output yet', () => {
    render(<PythonWidget bar={bar} state="input-available" />)
    expect(screen.getByText('print(6 * 7)')).toBeInTheDocument()
    expect(screen.getByText('tools:toolCall.working')).toBeInTheDocument()
    expect(screen.queryByText('tools:python.saveAs')).not.toBeInTheDocument()
  })

  it('lists notes verbatim and flags a stopped run', () => {
    renderDone(
      'partial\n[terminated by signal]\n[timed out after 30 s: split the work or pass a larger timeout, up to 300]'
    )
    expect(
      screen.getByText(
        '[timed out after 30 s: split the work or pass a larger timeout, up to 300]'
      )
    ).toBeInTheDocument()
    expect(screen.getByText('tools:toolCall.terminated')).toBeInTheDocument()
  })

  it('does not flag a run whose output was only truncated as stopped', () => {
    renderDone('tail\n[exit 0]\n[output truncated at 65536 of 90000 bytes]')
    expect(
      screen.getByText('[output truncated at 65536 of 90000 bytes]')
    ).toBeInTheDocument()
    expect(screen.queryByText('tools:toolCall.terminated')).toBeNull()
  })

  it('treats a setup failure as an error', () => {
    renderDone('ERROR: the runtime is not installed')
    expect(
      screen.getByText('ERROR: the runtime is not installed')
    ).toBeInTheDocument()
    expect(screen.getByTestId('python-status-error')).toBeInTheDocument()
  })

  it('shows the error text of a failed call', () => {
    render(
      <PythonWidget
        bar={bar}
        state="output-error"
        errorText="Tool execution failed"
      />
    )
    expect(screen.getByText('Tool execution failed')).toBeInTheDocument()
    expect(screen.getByTestId('python-status-error')).toBeInTheDocument()
  })

  describe('code', () => {
    const longCode = Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join(
      '\n'
    )

    it('folds code beyond 15 lines until it is expanded', () => {
      renderDone('[exit 0]', longCode)
      expect(screen.getByText(/x14 = 14/)).toBeInTheDocument()
      expect(screen.queryByText(/x15 = 15/)).not.toBeInTheDocument()

      fireEvent.click(screen.getByText('tools:toolCall.showMore'))
      expect(screen.getByText(/x19 = 19/)).toBeInTheDocument()

      fireEvent.click(screen.getByText('tools:toolCall.showLess'))
      expect(screen.queryByText(/x15 = 15/)).not.toBeInTheDocument()
    })

    it('does not fold code of exactly 15 lines', () => {
      renderDone('[exit 0]', longCode.split('\n').slice(0, 15).join('\n'))
      expect(screen.getByText(/x14 = 14/)).toBeInTheDocument()
      expect(
        screen.queryByText('tools:toolCall.showMore')
      ).not.toBeInTheDocument()
    })
  })

  describe('files', () => {
    it('lists each file with a readable size and a save button', () => {
      renderDone(fileResult)
      expect(screen.getByText('tools:python.files')).toBeInTheDocument()
      expect(screen.getByText('out/report.csv')).toBeInTheDocument()
      expect(screen.getByText('1.5 KB')).toBeInTheDocument()
      expect(screen.getByText('notes.txt')).toBeInTheDocument()
      expect(screen.getByText('12 B')).toBeInTheDocument()
      expect(screen.getAllByText('tools:python.saveAs')).toHaveLength(2)
    })

    it('says how many more files there are, and only when there are', () => {
      const { unmount } = renderDone(
        `${fileResult}\n[files: 7 more not listed]`
      )
      expect(
        screen.getByText('tools:python.moreFiles {"count":7}')
      ).toBeInTheDocument()
      unmount()

      renderDone(fileResult)
      expect(screen.queryByText(/tools:python.moreFiles/)).toBeNull()
    })

    it('saves the file it was asked for and reports where', async () => {
      hoisted.savePythonFile.mockResolvedValue('C:\\Users\\me\\report.csv')
      renderDone(fileResult)

      fireEvent.click(screen.getAllByText('tools:python.saveAs')[0])

      await waitFor(() =>
        expect(hoisted.toast.success).toHaveBeenCalledWith(
          'tools:python.saved {"path":"C:\\\\Users\\\\me\\\\report.csv"}'
        )
      )
      expect(hoisted.savePythonFile).toHaveBeenCalledWith(
        'thread-1',
        'out/report.csv'
      )
      expect(hoisted.toast.error).not.toHaveBeenCalled()
    })

    it('says nothing when the user cancels the dialog', async () => {
      hoisted.savePythonFile.mockResolvedValue(null)
      renderDone(fileResult)

      fireEvent.click(screen.getAllByText('tools:python.saveAs')[1])

      await waitFor(() =>
        expect(hoisted.savePythonFile).toHaveBeenCalledWith(
          'thread-1',
          'notes.txt'
        )
      )
      await waitFor(() =>
        expect(
          screen.getAllByText('tools:python.saveAs')[1].closest('button')
        ).toBeEnabled()
      )
      expect(hoisted.toast.success).not.toHaveBeenCalled()
      expect(hoisted.toast.error).not.toHaveBeenCalled()
    })

    it.each([
      ['an Error', new Error('a run is active in this chat')],
      ['a string', 'a run is active in this chat'],
      ['an object', { message: 'a run is active in this chat' }],
    ])('reports the reason when the save rejects with %s', async (_, err) => {
      hoisted.savePythonFile.mockRejectedValue(err)
      renderDone(fileResult)

      fireEvent.click(screen.getAllByText('tools:python.saveAs')[0])

      await waitFor(() =>
        expect(hoisted.toast.error).toHaveBeenCalledWith(
          'tools:python.saveFailed {"reason":"a run is active in this chat"}'
        )
      )
      expect(hoisted.toast.success).not.toHaveBeenCalled()
    })

    it('disables a button while its own save is open', async () => {
      let finish: (path: string | null) => void = () => {}
      hoisted.savePythonFile.mockReturnValue(
        new Promise<string | null>((resolve) => (finish = resolve))
      )
      renderDone(fileResult)

      const [first, second] = screen.getAllByText('tools:python.saveAs')
      fireEvent.click(first)
      fireEvent.click(first)

      expect(hoisted.savePythonFile).toHaveBeenCalledTimes(1)
      expect(first.closest('button')).toBeDisabled()
      expect(second.closest('button')).toBeEnabled()

      finish(null)
      await waitFor(() => expect(first.closest('button')).toBeEnabled())
    })
  })
})
