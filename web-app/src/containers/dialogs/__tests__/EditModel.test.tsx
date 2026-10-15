import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

const hoisted = vi.hoisted(() => ({
  updateProvider: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: hoisted.toast }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: () => ({ updateProvider: hoisted.updateProvider }),
}))

import { DialogEditModel } from '../EditModel'
import { TranslationProvider } from '@/i18n/TranslationContext'

const providerWith = (name: string, settings?: Record<string, unknown>) =>
  ({
    provider: name,
    active: true,
    settings: [],
    models: [
      {
        id: 'grok-4.7',
        capabilities: ['tools'],
        settings: {
          thinking_budget_tokens: { controller_props: { value: 'high' } },
          ...settings,
        },
      },
    ],
  }) as unknown as ModelProvider

const effortFlag = (value: boolean) => ({
  reasoning_effort_enabled: {
    key: 'reasoning_effort_enabled',
    title: 'Reasoning effort',
    description: '',
    controller_type: 'checkbox',
    controller_props: { value },
  },
})

const openDialog = (provider: ModelProvider) => {
  render(
    <TranslationProvider>
      <DialogEditModel provider={provider} modelId="grok-4.7" />
    </TranslationProvider>
  )
  const trigger = document.querySelector('[aria-haspopup="dialog"]')
  expect(trigger).not.toBeNull()
  fireEvent.click(trigger!)
}

const effortSwitch = () =>
  screen.getByRole('switch', { name: 'Reasoning effort' })

const savedModel = () => {
  expect(hoisted.updateProvider).toHaveBeenCalledTimes(1)
  const [, data] = hoisted.updateProvider.mock.calls[0]
  return (data as Partial<ModelProvider>).models![0]
}

describe('DialogEditModel — reasoning effort', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the switch for an Azure model, on by default', () => {
    openDialog(providerWith('azure'))
    expect(effortSwitch()).toBeChecked()
    expect(
      screen.getByText(
        'Send the reasoning effort chosen in the chat input. Jan turns this off by itself if the model rejects it.'
      )
    ).toBeInTheDocument()
  })

  it('reflects a stored off flag', () => {
    openDialog(providerWith('azure', effortFlag(false)))
    expect(effortSwitch()).not.toBeChecked()
  })

  it('does not show the switch for other providers', () => {
    openDialog(providerWith('openai'))
    expect(
      screen.queryByRole('switch', { name: 'Reasoning effort' })
    ).not.toBeInTheDocument()
  })

  it('saves the flag into the model settings, keeping the stored level', () => {
    openDialog(providerWith('azure'))
    fireEvent.click(effortSwitch())
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    const model = savedModel()
    expect(model.settings?.reasoning_effort_enabled).toEqual(
      effortFlag(false).reasoning_effort_enabled
    )
    expect(
      model.settings?.thinking_budget_tokens?.controller_props?.value
    ).toBe('high')
    expect(model.capabilities).toEqual(['tools'])
  })

  it('turns a stored off flag back on', () => {
    openDialog(providerWith('azure', effortFlag(false)))
    fireEvent.click(effortSwitch())
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    expect(
      savedModel().settings?.reasoning_effort_enabled?.controller_props?.value
    ).toBe(true)
  })

  it('keeps Save disabled until the switch changes', () => {
    openDialog(providerWith('azure'))
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })
})
