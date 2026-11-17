import { expect, it } from 'vitest'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import {
  observeAgentPickerAcquisition,
  retryAgentPickerCatalog
} from './agent-launch-picker-acquisition'

const listed: AgentPickerEntry['catalog'] = {
  origin: 'probe',
  fetchedAt: 1,
  listingNamesConfiguredModel: false,
  models: [{ id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', isDefault: false, efforts: [] }]
}

const antigravity: AgentPickerEntry = {
  agent: 'antigravity',
  label: 'Antigravity',
  rows: [{ kind: 'cli', agent: 'antigravity', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' },
  ownerKey: 'retry-test'
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

it('reads a failed catalog again while the picker stays open', async () => {
  let reads = 0
  let latest: AgentPickerEntry[] = []
  const stop = observeAgentPickerAcquisition(
    'retry-test',
    [antigravity],
    {
      catalog: async () => {
        reads += 1
        if (reads === 1) {
          throw new Error('agy models timed out')
        }
        return listed
      },
      support: async () => undefined
    },
    { publish: (entries) => (latest = entries), selected: () => undefined }
  )
  await settle()
  expect(latest[0]?.catalogRead).toBe('failed')

  retryAgentPickerCatalog('retry-test', 'antigravity')
  await settle()
  expect(reads).toBe(2)
  expect(latest[0]?.catalogRead).toBe('settled')
  expect(latest[0]?.catalog).toEqual(listed)
  stop()
})
