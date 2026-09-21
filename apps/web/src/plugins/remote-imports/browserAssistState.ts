/**
 * What to say about the in-tab probe for the companion browser helper.
 *
 * The helper is deliberately UNADVERTISED: it is being published to the Chrome Web
 * Store rather than handed out as an unpacked GitHub build, so nothing here offers a
 * download, install steps, or a link. The endpoints it uses still work, so anyone
 * already running it keeps their handoff, this only governs what we say.
 *
 * The rule: mention the helper ONLY to someone who already has it. A user without it
 * gets an honest statement of what this browser cannot do, never a pitch for
 * something they have no way to obtain. `null` while the probe is still out, so a
 * flash of the wrong answer never appears.
 */
export function getBrowserAssistStatusCopy(extensionDetected: boolean | null) {
  if (extensionDetected == null) {
    return null
  }

  return extensionDetected
    ? {
        color: 'success' as const,
        title: 'Browser helper is connected',
        message: 'Open the model page and use the PrintStream button there to send a file straight over.'
      }
    : {
        color: 'neutral' as const,
        title: 'Use an app or download manually',
        message: 'The desktop and Android apps can capture the download. In this browser, download the file yourself and upload it to the library.'
      }
}
