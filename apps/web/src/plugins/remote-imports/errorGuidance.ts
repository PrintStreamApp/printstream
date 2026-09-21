export interface RemoteImportErrorGuidance {
  title: string
  steps: string[]
  note: string
  requiresManualIntervention: boolean
}

export function getRemoteImportErrorGuidance(message: string | null | undefined): RemoteImportErrorGuidance | null {
  const normalized = String(message ?? '').trim()
  const isMakerWorldSecurityChallenge = /makerworld/i.test(normalized)
    && /(security challenge|anti-bot|captcha|robot|418)/i.test(normalized)
  if (!isMakerWorldSecurityChallenge) {
    return null
  }

  return {
    title: 'Manual download required',
    steps: [
      'Open the model on MakerWorld and download the 3MF in your browser.',
      'Return to the PrintStream Library, choose Upload files, and select the downloaded file.'
    ],
    note: 'Completing the security check in your browser does not grant PrintStream access to retry this URL.',
    requiresManualIntervention: true
  }
}
