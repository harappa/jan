import { beforeEach, describe, expect, it, vi } from 'vitest'

const pythonStatus = vi.fn()
const pythonRun = vi.fn()
const pythonCancel = vi.fn()
const pythonSaveFile = vi.fn()
const getJanDataFolder = vi.fn()

vi.mock('@janhq/tauri-plugin-agent-tools-api', () => ({
  pythonStatus: () => pythonStatus(),
  pythonRun: (...args: unknown[]) => pythonRun(...args),
  pythonCancel: (...args: unknown[]) => pythonCancel(...args),
  pythonSaveFile: (...args: unknown[]) => pythonSaveFile(...args),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ app: () => ({ getJanDataFolder }) }),
}))

describe('parsePythonOutput', () => {
  it('reads the exit code and keeps the program output as the body', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    expect(parsePythonOutput('hello\nworld\n[exit 0]')).toEqual({
      body: 'hello\nworld',
      exitCode: 0,
      files: [],
      moreFiles: 0,
      notes: [],
    })
  })

  it('reads a failing exit code', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput('Traceback\n  boom\n[exit 1]')
    expect(parsed.exitCode).toBe(1)
    expect(parsed.body).toBe('Traceback\n  boom')
  })

  it('keeps the program leading whitespace and trims only trailing blank lines', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    expect(parsePythonOutput('  indented\n\n\n[exit 0]').body).toBe(
      '  indented'
    )
    expect(parsePythonOutput('\n  x\n[exit 0]').body).toBe('\n  x')
  })

  it('lists files, including names with spaces and parentheses', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput(
      [
        'done',
        '[exit 0]',
        '[file: a b.csv (12 bytes)]',
        '[file: out/report (final) (3).txt (2048 bytes)]',
        '[file: 結果/表.csv (7 bytes)]',
      ].join('\n')
    )
    expect(parsed.files).toEqual([
      { path: 'a b.csv', size: 12 },
      { path: 'out/report (final) (3).txt', size: 2048 },
      { path: '結果/表.csv', size: 7 },
    ])
    expect(parsed.body).toBe('done')
  })

  it('reads how many files were not listed', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput(
      '[exit 0]\n[file: a.txt (1 bytes)]\n[files: 3 more not listed]'
    )
    expect(parsed.moreFiles).toBe(3)
    expect(parsed.files).toEqual([{ path: 'a.txt', size: 1 }])
  })

  it('collects timeout, stop, skipped-input and truncation lines as notes, in order', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const lines = [
      'x',
      '[exit 1]',
      '[output truncated at 10 of 99 bytes]',
      '[input skipped: big (1).bin (larger than 256 MB)]',
      '[timed out after 30 s: split the work or pass a larger timeout, up to 300]',
      '[stopped: the run wrote more than 1 GB to the workspace]',
      '[file: out.csv (12 bytes)]',
    ]
    const parsed = parsePythonOutput(lines.join('\n'))
    expect(parsed.notes).toEqual(lines.slice(2, 6))
    expect(parsed.body).toBe('x')
    expect(parsed.files).toEqual([{ path: 'out.csv', size: 12 }])
  })

  it('treats "terminated by signal" like an exit marker and keeps it as a note', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    expect(parsePythonOutput('x\n[terminated by signal]')).toEqual({
      body: 'x',
      exitCode: undefined,
      files: [],
      moreFiles: 0,
      notes: ['[terminated by signal]'],
    })
    const timedOut =
      '[timed out after 2 s: split the work or pass a larger timeout, up to 300]'
    const stopped = '[stopped: the run used more than 2 GB of disk space]'
    const parsed = parsePythonOutput(
      ['[terminated by signal]', timedOut, stopped, '[file: a (1 bytes)]'].join(
        '\n'
      )
    )
    expect(parsed.body).toBe('')
    expect(parsed.exitCode).toBeUndefined()
    expect(parsed.notes).toEqual(['[terminated by signal]', timedOut, stopped])
    expect(parsed.files).toEqual([{ path: 'a', size: 1 }])
  })

  it('anchors on "terminated by signal" so earlier look-alike lines stay in the body', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput(
      '[exit 3]\n[terminated by signal]\n[stopped: cancelled by the user]'
    )
    expect(parsed.body).toBe('[exit 3]')
    expect(parsed.exitCode).toBeUndefined()
    expect(parsed.notes).toEqual([
      '[terminated by signal]',
      '[stopped: cancelled by the user]',
    ])
  })

  it('reads a cancelled run', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput(
      '[exit 1]\n[stopped: cancelled by the user]'
    )
    expect(parsed.notes).toEqual(['[stopped: cancelled by the user]'])
  })

  it('leaves a setup error as the body without markers', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    expect(
      parsePythonOutput('ERROR: the python runtime is not installed')
    ).toEqual({
      body: 'ERROR: the python runtime is not installed',
      exitCode: undefined,
      files: [],
      moreFiles: 0,
      notes: [],
    })
  })

  it('does not mistake a marker-looking line in the program output for a marker', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput(
      '[file: fake.txt (1 bytes)]\nmore\n[exit 0]'
    )
    expect(parsed.files).toEqual([])
    expect(parsed.body).toBe('[file: fake.txt (1 bytes)]\nmore')
    expect(parsePythonOutput('[exit 5]\n[exit 0]')).toMatchObject({
      body: '[exit 5]',
      exitCode: 0,
    })
  })

  it('handles CRLF line endings', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    const parsed = parsePythonOutput('a\r\n[exit 0]\r\n[file: b.txt (2 bytes)]')
    expect(parsed.exitCode).toBe(0)
    expect(parsed.files).toEqual([{ path: 'b.txt', size: 2 }])
    expect(parsed.body).toBe('a')
  })

  it('returns an empty body for an empty run', async () => {
    const { parsePythonOutput } = await import('../pythonTool')
    expect(parsePythonOutput('[exit 0]')).toMatchObject({
      body: '',
      exitCode: 0,
    })
  })
})

describe('getPythonStatus', () => {
  beforeEach(() => {
    vi.resetModules()
    pythonStatus.mockReset()
  })

  it('asks Tauri once and caches the answer', async () => {
    pythonStatus.mockResolvedValue({ available: true, reason: null })
    const { getPythonStatus } = await import('../pythonTool')
    expect(await getPythonStatus()).toEqual({ available: true })
    expect(await getPythonStatus()).toEqual({ available: true })
    expect(pythonStatus).toHaveBeenCalledTimes(1)
  })

  it('shares one question between concurrent callers', async () => {
    pythonStatus.mockResolvedValue({ available: true, reason: null })
    const { getPythonStatus } = await import('../pythonTool')
    await Promise.all([getPythonStatus(), getPythonStatus()])
    expect(pythonStatus).toHaveBeenCalledTimes(1)
  })

  it('carries the reason when the tool is unavailable', async () => {
    pythonStatus.mockResolvedValue({ available: false, reason: 'no sandbox' })
    const { getPythonStatus } = await import('../pythonTool')
    expect(await getPythonStatus()).toEqual({
      available: false,
      reason: 'no sandbox',
    })
  })

  it('treats a synchronous throw from the plugin as unavailable', async () => {
    pythonStatus.mockImplementation(() => {
      throw new Error('sync boom')
    })
    const { getPythonStatus } = await import('../pythonTool')
    const status = await getPythonStatus()
    expect(status.available).toBe(false)
    expect(status.reason).toContain('sync boom')
  })

  it('caches an unavailable answer when Tauri throws, and never throws', async () => {
    pythonStatus.mockRejectedValue(new Error('not in tauri'))
    const { getPythonStatus } = await import('../pythonTool')
    const first = await getPythonStatus()
    expect(first.available).toBe(false)
    expect(first.reason).toContain('not in tauri')
    await getPythonStatus()
    expect(pythonStatus).toHaveBeenCalledTimes(1)
  })
})

describe('tool definition', () => {
  it('exposes the exact model-facing copy', async () => {
    const mod = await import('../pythonTool')
    expect(mod.PYTHON_TOOL_NAME).toBe('python')
    expect(
      mod.PYTHON_TOOL_DESCRIPTION.startsWith(
        "Run Python 3.15 code in an isolated sandbox on the user's computer and return its output.\n"
      )
    ).toBe(true)
    expect(mod.PYTHON_TOOL_DESCRIPTION).toContain(
      'the run stops after `timeout` seconds (default 30, at most 300)'
    )
    expect(
      mod.PYTHON_TOOL_DESCRIPTION.endsWith(
        'The result ends with the exit code and the files the run created or changed.'
      )
    ).toBe(true)
    expect(mod.PYTHON_SYSTEM_SECTION).toBe(
      '# Python\nYou can run Python with the `python` tool. Use it whenever an answer depends on exact computation, on counting or transforming data, or on the contents of attached files, instead of working it out by hand. It runs offline in a sandbox with the standard library only.'
    )
  })

  it('requires code and bounds the timeout', async () => {
    const { PYTHON_TOOL_INPUT_SCHEMA } = await import('../pythonTool')
    expect(PYTHON_TOOL_INPUT_SCHEMA.required).toEqual(['code'])
    expect(PYTHON_TOOL_INPUT_SCHEMA.properties.code.type).toBe('string')
    expect(PYTHON_TOOL_INPUT_SCHEMA.properties.timeout).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 300,
    })
  })
})

describe('executePython and friends', () => {
  beforeEach(() => {
    pythonRun.mockReset()
    pythonCancel.mockReset()
    pythonSaveFile.mockReset()
    getJanDataFolder.mockReset().mockResolvedValue('/data')
  })

  it('runs the code in the chat with the data folder and attachments', async () => {
    pythonRun.mockResolvedValue({
      content: '3\n[exit 0]',
      diff: null,
      isError: false,
    })
    const { executePython } = await import('../pythonTool')
    const attachments = [{ name: 'a.csv', path: '/tmp/a.csv' }]
    const result = await executePython(
      'thread-1',
      { code: 'print(3)', timeout: 60 },
      attachments
    )
    expect(pythonRun).toHaveBeenCalledWith(
      '/data',
      'thread-1',
      'print(3)',
      60,
      attachments
    )
    expect(result).toEqual({ content: '3\n[exit 0]', isError: false })
  })

  it('passes no timeout when the model gave none or a non-number', async () => {
    pythonRun.mockResolvedValue({
      content: '[exit 0]',
      diff: null,
      isError: false,
    })
    const { executePython } = await import('../pythonTool')
    await executePython('t', { code: 'pass' }, [])
    await executePython('t', { code: 'pass', timeout: '60' as never }, [])
    expect(pythonRun.mock.calls[0][3]).toBeUndefined()
    expect(pythonRun.mock.calls[1][3]).toBeUndefined()
  })

  it('reports a failed run as an error result', async () => {
    pythonRun.mockResolvedValue({
      content: 'boom\n[exit 1]',
      diff: null,
      isError: true,
    })
    const { executePython } = await import('../pythonTool')
    expect(await executePython('t', { code: 'x' }, [])).toEqual({
      content: 'boom\n[exit 1]',
      isError: true,
    })
  })

  it('turns an IPC failure into an error result instead of throwing', async () => {
    pythonRun.mockRejectedValue(new Error('ipc down'))
    const { executePython } = await import('../pythonTool')
    const result = await executePython('t', { code: 'x' }, [])
    expect(result.isError).toBe(true)
    expect(result.content).toBe('ERROR: ipc down')
  })

  it('reports a missing data folder as an error result', async () => {
    getJanDataFolder.mockResolvedValue('')
    const { executePython } = await import('../pythonTool')
    const result = await executePython('t', { code: 'x' }, [])
    expect(result).toEqual({
      content: 'ERROR: Jan data folder is unavailable',
      isError: true,
    })
    expect(pythonRun).not.toHaveBeenCalled()
  })

  it('cancels the chat run and reports false when the call fails', async () => {
    pythonCancel.mockResolvedValueOnce(true)
    const { cancelPython } = await import('../pythonTool')
    expect(await cancelPython('thread-1')).toBe(true)
    expect(pythonCancel).toHaveBeenCalledWith('thread-1')
    pythonCancel.mockRejectedValueOnce(new Error('x'))
    expect(await cancelPython('thread-1')).toBe(false)
  })

  it('saves a file through the plugin and returns the chosen path', async () => {
    pythonSaveFile.mockResolvedValue('/home/u/out.csv')
    const { savePythonFile } = await import('../pythonTool')
    expect(await savePythonFile('thread-1', 'out.csv')).toBe('/home/u/out.csv')
    expect(pythonSaveFile).toHaveBeenCalledWith('/data', 'thread-1', 'out.csv')
  })

  it('returns null when the user cancels the save dialog', async () => {
    pythonSaveFile.mockResolvedValue(null)
    const { savePythonFile } = await import('../pythonTool')
    expect(await savePythonFile('thread-1', 'out.csv')).toBeNull()
  })

  it('lets a save failure reach the caller', async () => {
    pythonSaveFile.mockRejectedValue({ message: 'a run is active' })
    const { savePythonFile } = await import('../pythonTool')
    await expect(savePythonFile('thread-1', 'out.csv')).rejects.toBeDefined()
  })
})
