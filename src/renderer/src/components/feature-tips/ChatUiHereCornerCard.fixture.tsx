import { useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import { createGlobalSettingsFixture } from '../../../../shared/settings/global-settings-test-fixture'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { useAppStore } from '@/store'
import { Toaster } from '../ui/sonner'
import { ChatUiHereCornerCard } from './ChatUiHereCornerCard'

export const open = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({ agentDefaultSurface: 'terminal' })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})

export const swappedButtons = defineFixture({
  width: 360,
  store: {
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      telemetry: {
        optedIn: true,
        installId: 'install',
        existedBeforeTelemetryRelease: true,
        chatUiLaunchTipCohort: 'treatment',
        chatUiLaunchTipButtonEmphasis: 'swapped'
      }
    })
  },
  render: () => <ChatUiHereCornerCard onClose={() => {}} />
})

// The fixture bridge has no runtime to persist settings; apply the write to the store directly.
function applySettings(updates: Partial<GlobalSettings>): Promise<void> {
  const settings = useAppStore.getState().settings
  useAppStore.setState({ settings: settings && { ...settings, ...updates } })
  return Promise.resolve()
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error('Timed out waiting for fixture element')
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function ClosableCornerCard(): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  return open ? <ChatUiHereCornerCard onClose={() => setOpen(false)} /> : null
}

export const keptAgents = defineFixture({
  width: 1280,
  store: {
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: 'terminal',
      nativeChatProviders: { claude: false }
    }),
    updateSettingsOrThrow: applySettings
  },
  render: () => (
    <>
      <div className="flex h-[900px] w-[360px] items-end p-4">
        <ClosableCornerCard />
      </div>
      <Toaster closeButton toastOptions={{ className: 'font-sans text-sm' }} />
    </>
  ),
  interact: async (frame) => {
    toast.dismiss()
    const use = [...frame.querySelectorAll('button')].find((button) =>
      /Use Chat UI/.test(button.textContent ?? '')
    )
    use?.click()
    await waitFor(() => !!document.querySelector('[data-sonner-toast][data-mounted="true"]'))
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
})
