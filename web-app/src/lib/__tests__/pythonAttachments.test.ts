import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'

const listAttachments = vi.fn()
let extension: { listAttachments?: typeof listAttachments } | undefined

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({ get: () => extension }),
  },
}))

vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
}))

import { collectPythonAttachments } from '../pythonAttachments'

const user = (id: string, metadata?: unknown): UIMessage =>
  ({
    id,
    role: 'user',
    parts: [{ type: 'text', text: 'hi' }],
    metadata,
  }) as UIMessage

describe('collectPythonAttachments', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    listAttachments.mockReset()
    listAttachments.mockResolvedValue([])
    extension = { listAttachments }
  })

  it('collects native files, inline contents and the thread attachments', async () => {
    listAttachments.mockResolvedValue([
      {
        id: 'f1',
        name: 'notes.docx',
        path: '/data/notes.docx',
        chunk_count: 3,
      },
    ])
    const messages = [
      user('u1', {
        native_files: [
          { name: 'a.pdf', path: '/data/a.pdf', media_type: 'application/pdf' },
        ],
        inline_file_contents: [{ name: 'log.txt', content: 'hello' }],
      }),
    ]

    expect(await collectPythonAttachments('t1', messages)).toEqual([
      { name: 'a.pdf', path: '/data/a.pdf' },
      { name: 'log.txt', content: 'hello' },
      { name: 'notes.docx', path: '/data/notes.docx' },
    ])
    expect(listAttachments).toHaveBeenCalledWith('t1')
  })

  it('keeps message order and takes the first of attachments sharing a path', async () => {
    listAttachments.mockResolvedValue([
      { id: 'f1', name: 'a-again.pdf', path: '/data/a.pdf', chunk_count: 1 },
      { id: 'f2', name: 'b.csv', path: '/data/b.csv', chunk_count: 1 },
    ])
    const messages = [
      user('u1', {
        native_files: [{ name: 'a.pdf', path: '/data/a.pdf', media_type: 'x' }],
      }),
      user('u2', {
        native_files: [
          { name: 'a-copy.pdf', path: '/data/a.pdf', media_type: 'x' },
        ],
      }),
    ]

    expect(await collectPythonAttachments('t1', messages)).toEqual([
      { name: 'a.pdf', path: '/data/a.pdf' },
      { name: 'b.csv', path: '/data/b.csv' },
    ])
  })

  it('reads only user messages', async () => {
    const assistant = {
      id: 'a1',
      role: 'assistant',
      parts: [],
      metadata: {
        native_files: [{ name: 'x.pdf', path: '/data/x.pdf', media_type: 'x' }],
      },
    } as unknown as UIMessage
    expect(await collectPythonAttachments('t1', [assistant])).toEqual([])
  })

  it('passes no images: they are not in the metadata', async () => {
    const messages = [
      user('u1', {
        tokenSpeed: { tokenCount: 3 },
        images: [{ name: 'cat.png', path: '/data/cat.png' }],
      }),
      user('u2'),
    ]
    expect(await collectPythonAttachments('t1', messages)).toEqual([])
  })

  it('skips entries that are malformed or empty', async () => {
    listAttachments.mockResolvedValue([
      { id: 'f1', name: 'no-path', chunk_count: 1 },
      { id: 'f2', path: '/data/no-name.txt', chunk_count: 1 },
    ])
    const messages = [
      user('u1', {
        native_files: [
          null,
          { name: 'x.pdf' },
          { path: '/data/y.pdf' },
          { name: 7, path: '/data/z.pdf' },
        ],
        inline_file_contents: [
          { name: 'empty.txt', content: '' },
          { name: 'bad', content: 5 },
          { content: 'nameless' },
          { name: 'ok.txt', content: 'fine' },
        ],
      }),
      user('u2', { native_files: 'nope', inline_file_contents: {} }),
    ]
    expect(await collectPythonAttachments('t1', messages)).toEqual([
      { name: 'ok.txt', content: 'fine' },
    ])
  })

  it('keeps the message attachments when listing the thread attachments fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listAttachments.mockRejectedValue(new Error('vector db is down'))
    const messages = [
      user('u1', {
        inline_file_contents: [{ name: 'log.txt', content: 'hello' }],
      }),
    ]

    expect(await collectPythonAttachments('t1', messages)).toEqual([
      { name: 'log.txt', content: 'hello' },
    ])
    expect(warn).toHaveBeenCalled()
  })

  it('works when no vector database extension is installed', async () => {
    extension = undefined
    const messages = [
      user('u1', {
        native_files: [{ name: 'a.pdf', path: '/data/a.pdf', media_type: 'x' }],
      }),
    ]
    expect(await collectPythonAttachments('t1', messages)).toEqual([
      { name: 'a.pdf', path: '/data/a.pdf' },
    ])
  })
})
