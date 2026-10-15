import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModelV3, SharedV3ProviderOptions } from '@ai-sdk/provider'
import { ModelFactory, createCustomFetch } from '../model-factory'
import { buildReasoningProviderOptions } from '../reasoningProviderOptions'
import { useModelProvider } from '@/hooks/useModelProvider'

const toast = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))

const AZURE_BASE_URL = 'https://my-resource.openai.azure.com/openai/v1'

const azureModel = (settings: Record<string, unknown> = {}) =>
  ({
    id: 'gpt-6.1-sol',
    settings: {
      thinking_budget_tokens: { controller_props: { value: 'xhigh' } },
      ...settings,
    },
  }) as unknown as Model

const prompt = [
  {
    role: 'user' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
  },
]

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

// The two shapes Azure answers a reasoning field it does not take with.
const unsupportedParameter = () =>
  jsonResponse(400, {
    error: {
      message:
        "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
      type: 'invalid_request_error',
      param: 'reasoning.effort',
      code: 'unsupported_parameter',
    },
  })
const unsupportedValue = () =>
  jsonResponse(400, {
    error: {
      message:
        "Unsupported value: 'reasoning.effort' does not support 'xhigh' with this model.",
      type: 'invalid_request_error',
      param: null,
      code: 'unsupported_value',
    },
  })

const okResponse = () => jsonResponse(200, { id: 'resp_1' })

const bodyOf = (call: unknown[]) =>
  JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}'))

describe('Azure reasoning effort through the real OpenAI provider', () => {
  // Azure deployment ids (gpt-6.1-sol, grok-4.7, ...) are not on the SDK's
  // reasoning-model allowlist, so without forceReasoning the SDK drops the
  // effort with only a warning and Azure never sees it.
  it('puts the chosen effort and a summary into the Responses request', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(400, { error: { message: 'stubbed' } })
    )
    const openai = createOpenAI({
      apiKey: 'test-key',
      baseURL: AZURE_BASE_URL,
      fetch: fetchMock,
    })
    const model = openai.responses('gpt-6.1-sol')

    await expect(
      model.doGenerate({
        prompt,
        providerOptions: buildReasoningProviderOptions(
          'azure',
          azureModel()
        ) as SharedV3ProviderOptions,
      })
    ).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodyOf(fetchMock.mock.calls[0])).toMatchObject({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'xhigh', summary: 'auto' },
    })
  })
})

describe('createCustomFetch — reasoning effort rejection', () => {
  const guard = () => ({ modelId: 'grok-4.7', onRejected: vi.fn() })
  const reasoningBody = (extra: Record<string, unknown> = {}) => ({
    method: 'POST',
    body: JSON.stringify({
      model: 'grok-4.7',
      input: [],
      reasoning: { effort: 'high', summary: 'auto' },
      ...extra,
    }),
  })

  beforeEach(() => {
    toast.warning.mockReset()
  })

  it.each([
    ['unsupported_parameter', unsupportedParameter],
    ['unsupported_value', unsupportedValue],
  ])(
    'retries once without reasoning and turns effort off (%s)',
    async (_shape, rejection) => {
      const baseFetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(rejection())
        .mockResolvedValueOnce(okResponse())
      const g = guard()
      const wrapped = createCustomFetch(
        baseFetch,
        { max_output_tokens: 256 },
        false,
        undefined,
        false,
        g
      )

      const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: 'resp_1' })
      expect(baseFetch).toHaveBeenCalledTimes(2)
      const first = bodyOf(baseFetch.mock.calls[0])
      const retry = bodyOf(baseFetch.mock.calls[1])
      expect(first.reasoning).toEqual({ effort: 'high', summary: 'auto' })
      expect(retry).not.toHaveProperty('reasoning')
      // Everything else, injected params included, is sent again.
      expect(retry).toMatchObject({
        model: 'grok-4.7',
        input: [],
        max_tokens: 256,
      })
      expect(g.onRejected).toHaveBeenCalledTimes(1)
      await vi.waitFor(() => expect(toast.warning).toHaveBeenCalledTimes(1))
      expect(toast.warning).toHaveBeenCalledWith(
        'Reasoning effort turned off',
        expect.objectContaining({
          description: expect.stringContaining('grok-4.7 did not accept'),
        })
      )
    }
  )

  it('turns effort off even when the retry fails too', async () => {
    const baseFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(unsupportedParameter())
      .mockResolvedValueOnce(
        jsonResponse(400, { error: { message: 'Invalid input' } })
      )
    const g = guard()
    const wrapped = createCustomFetch(baseFetch, {}, false, undefined, false, g)

    const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe('Invalid input')
    expect(baseFetch).toHaveBeenCalledTimes(2)
    expect(g.onRejected).toHaveBeenCalledTimes(1)
  })

  it('stops sending reasoning on later requests through the same fetch', async () => {
    const baseFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(unsupportedParameter())
      .mockResolvedValue(okResponse())
    const g = guard()
    const wrapped = createCustomFetch(baseFetch, {}, false, undefined, false, g)

    await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())
    // A later step of the same tool loop still carries the effort.
    await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(baseFetch).toHaveBeenCalledTimes(3)
    expect(bodyOf(baseFetch.mock.calls[2])).not.toHaveProperty('reasoning')
    expect(g.onRejected).toHaveBeenCalledTimes(1)
  })

  it('lets the sampling retry run after the reasoning retry, and no more', async () => {
    const samplingRejection = () =>
      jsonResponse(400, {
        error: {
          message:
            "Unsupported parameter: 'top_k' is not supported with this model.",
          param: 'top_k',
        },
      })
    const baseFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(unsupportedParameter())
      .mockResolvedValueOnce(samplingRejection())
      .mockResolvedValueOnce(samplingRejection())
    const g = guard()
    const wrapped = createCustomFetch(
      baseFetch,
      { top_k: 40 },
      false,
      undefined,
      false,
      g
    )

    const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(res.status).toBe(400)
    expect(baseFetch).toHaveBeenCalledTimes(3)
    const third = bodyOf(baseFetch.mock.calls[2])
    expect(third).not.toHaveProperty('reasoning')
    expect(third).not.toHaveProperty('top_k')
    expect(g.onRejected).toHaveBeenCalledTimes(1)
  })

  it.each([
    [500, 'server_error'],
    [408, 'timeout'],
    [429, 'rate_limit_exceeded'],
  ])('leaves a %d alone', async (status, code) => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse(status, {
        error: {
          message: "Something went wrong with 'reasoning.effort'.",
          param: 'reasoning.effort',
          code,
        },
      })
    )
    const g = guard()
    const wrapped = createCustomFetch(baseFetch, {}, false, undefined, false, g)

    const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(res.status).toBe(status)
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(g.onRejected).not.toHaveBeenCalled()
  })

  it('keeps the sampling retry for a 400 about another parameter', async () => {
    const baseFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse(400, {
          error: {
            message:
              "Unsupported parameter: 'top_k' is not supported with this model.",
            param: 'top_k',
            code: 'unsupported_parameter',
          },
        })
      )
      .mockResolvedValueOnce(okResponse())
    const g = guard()
    const wrapped = createCustomFetch(
      baseFetch,
      { top_k: 40 },
      false,
      undefined,
      false,
      g
    )

    const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(res.status).toBe(200)
    expect(baseFetch).toHaveBeenCalledTimes(2)
    const retry = bodyOf(baseFetch.mock.calls[1])
    // As before: the bare SDK body, which still carries its reasoning.
    expect(retry).not.toHaveProperty('top_k')
    expect(retry.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(g.onRejected).not.toHaveBeenCalled()
  })

  it('does nothing for a request that sent no reasoning', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () =>
      unsupportedParameter()
    )
    const g = guard()
    const wrapped = createCustomFetch(baseFetch, {}, false, undefined, false, g)

    const res = await wrapped(AZURE_BASE_URL + '/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'grok-4.7', input: [] }),
    })

    expect(res.status).toBe(400)
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(g.onRejected).not.toHaveBeenCalled()
  })

  it('does nothing without a guard (providers other than Azure)', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(async () =>
      unsupportedParameter()
    )
    const wrapped = createCustomFetch(baseFetch, {})

    const res = await wrapped(AZURE_BASE_URL + '/responses', reasoningBody())

    expect(res.status).toBe(400)
    expect(baseFetch).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

describe('ModelFactory — Azure turns reasoning effort off when rejected', () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>()

  const seedProvider = (name: string, extra: Partial<ModelProvider> = {}) => {
    const provider = {
      provider: name,
      active: true,
      api_key: 'key-1',
      base_url: AZURE_BASE_URL,
      settings: [],
      models: [
        azureModel(),
        { id: 'gpt-6-luna', settings: {} } as unknown as Model,
      ],
      ...extra,
    } as unknown as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: name,
      selectedModel: provider.models[0],
    })
    return provider
  }

  const effortFlag = (name: string, modelId: string) =>
    useModelProvider
      .getState()
      .getProviderByName(name)
      ?.models.find((m) => m.id === modelId)?.settings?.reasoning_effort_enabled

  // The responses are stubs, so the call itself fails; what is under test is
  // what was sent and what was stored.
  const callWithEffort = async (provider: ModelProvider) => {
    const model = (await ModelFactory.createModel(
      'gpt-6.1-sol',
      provider as unknown as ProviderObject
    )) as LanguageModelV3
    await model
      .doGenerate({
        prompt,
        providerOptions: {
          openai: {
            reasoningEffort: 'xhigh',
            reasoningSummary: 'auto',
            forceReasoning: true,
          },
        },
      })
      .catch(() => undefined)
  }

  beforeEach(() => {
    fetchMock.mockReset()
    toast.warning.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['one API key', {}],
    ['several API keys', { api_key_fallbacks: ['key-2'] }],
  ])(
    'stores the flag as off for that model only (%s)',
    async (_label, extra) => {
      fetchMock
        .mockResolvedValueOnce(unsupportedParameter())
        .mockResolvedValue(jsonResponse(400, { error: { message: 'stubbed' } }))
      const provider = seedProvider('azure', extra)

      await callWithEffort(provider)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(bodyOf(fetchMock.mock.calls[1])).not.toHaveProperty('reasoning')
      expect(effortFlag('azure', 'gpt-6.1-sol')).toEqual({
        key: 'reasoning_effort_enabled',
        title: 'Reasoning effort',
        description: '',
        controller_type: 'checkbox',
        controller_props: { value: false },
      })
      expect(effortFlag('azure', 'gpt-6-luna')).toBeUndefined()
      // The stored level stays, so turning the flag back on restores it.
      expect(
        useModelProvider.getState().selectedModel?.settings
          ?.thinking_budget_tokens?.controller_props?.value
      ).toBe('xhigh')
      expect(
        useModelProvider.getState().selectedModel?.settings
          ?.reasoning_effort_enabled?.controller_props?.value
      ).toBe(false)
    }
  )

  it('leaves the openai provider as it was', async () => {
    fetchMock.mockResolvedValue(unsupportedParameter())
    const provider = seedProvider('openai', {
      base_url: 'https://api.openai.com/v1',
    })

    await callWithEffort(provider)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(effortFlag('openai', 'gpt-6.1-sol')).toBeUndefined()
  })
})
