/**
 * Canonical copy for the "How printers connect" explainer: the local bridge,
 * Bambu LAN Only Mode + access code, and the Developer Mode requirement on
 * newer firmware.
 *
 * This is the single source of truth for that story. The in-app
 * `ConnectivityGuideDialog` renders it during workspace setup, and the cloud
 * marketing site (private module) reuses the same steps so the two surfaces
 * never drift. Keep the copy deployment-neutral — it ships in the public
 * self-hosted build too, so cloud-specific framing belongs in the private
 * marketing pages, and managed-bridge wording lives in the dialog.
 */

export interface PrinterConnectivityStep {
  id: 'bridge' | 'lan-mode' | 'developer-mode'
  title: string
  body: string
}

/** One-line framing for the guide, shared by the dialog and marketing surfaces. */
export const PRINTER_CONNECTIVITY_INTRO =
  'PrintStream talks to your Bambu printers directly over your own network — no traffic is routed through Bambu’s cloud. That needs three things.'

export const PRINTER_CONNECTIVITY_STEPS: PrinterConnectivityStep[] = [
  {
    id: 'bridge',
    title: 'A bridge on your printers’ network',
    body: 'The bridge is a small service that runs on the same local network as your printers and connects outward to PrintStream. Because it only dials out, nothing on your network is exposed to the internet and no port forwarding is needed. Any always-on machine works — a Raspberry Pi or a computer that stays on is plenty.'
  },
  {
    id: 'lan-mode',
    title: 'LAN mode enabled on each printer',
    body: 'On the printer’s screen, turn on LAN Only Mode and note the access code shown with it. PrintStream uses that code to connect to the printer over your local network, and treats it as a secret.'
  },
  {
    id: 'developer-mode',
    title: 'Developer Mode on newer firmware',
    body: 'Recent Bambu firmware also requires Developer Mode (found in the LAN Only Mode settings on the printer screen) before local apps may connect. Older firmware has no such switch and needs no extra step — the connection test when adding a printer tells you if the printer is still rejecting connections.'
  }
]

/**
 * The honest trade-off of LAN Only Mode, stated once so setup and marketing
 * describe it the same way.
 */
export const LAN_ONLY_MODE_TRADEOFF =
  'In LAN Only Mode a printer disconnects from Bambu’s cloud, so Bambu Handy and cloud printing no longer reach it. Bambu Studio keeps working over the local network, and PrintStream takes over monitoring and control from anywhere.'

/**
 * Managed-bridge replacement for the bridge step: the server owns a bundled
 * bridge, so there is nothing for the operator to install or pair.
 */
export const MANAGED_BRIDGE_STEP: PrinterConnectivityStep = {
  id: 'bridge',
  title: 'Printer connectivity is built in',
  body: 'This PrintStream server includes its own printer connection service, so there is nothing to install — printers on the server’s local network are reached automatically.'
}
