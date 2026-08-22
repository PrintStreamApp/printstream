export interface RemoteImportErrorGuidance {
  title: string
  steps: string[]
  note: string
  requiresManualIntervention: boolean
}

export function getRemoteImportErrorGuidance(message: string | null | undefined): RemoteImportErrorGuidance | null {
  const normalized = String(message ?? '').trim()
  if (!/makerworld/i.test(normalized) || !/(captcha|robot|418)/i.test(normalized)) {
    return null
  }

  return {
    title: 'Manual Intervention Required',
    steps: [
      'Refresh the captcha on MakerWorld by manually clicking the download button on the model page.',
      'Solve the challenge there in MakerWorld.',
      'Try Import to PrintStream again.'
    ],
    note: 'This check appears to be a random Bambu anti-bot challenge that can be tied to your IP address or VPN. If you do not want to solve it immediately, it can sometimes clear on its own after a few hours.',
    requiresManualIntervention: true
  }
}
