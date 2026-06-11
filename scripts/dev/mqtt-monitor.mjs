/**
 * Temporary MQTT monitor — subscribes to both request and report topics
 * for a printer and logs all messages with timestamps.
 *
 * Usage: node mqtt-monitor.mjs <host> <serial> <access_code>
 */
import mqtt from 'mqtt'

const [,, host, serial, accessCode] = process.argv
if (!host || !serial || !accessCode) {
  console.error('Usage: node mqtt-monitor.mjs <host> <serial> <access_code>')
  process.exit(1)
}

const url = `mqtts://${host}:8883`
const client = mqtt.connect(url, {
  username: 'bblp',
  password: accessCode,
  rejectUnauthorized: false,
  clientId: `mqtt-monitor-${Date.now()}`
})

const requestTopic = `device/${serial}/request`
const reportTopic = `device/${serial}/report`

client.on('connect', () => {
  console.log(`✓ Connected to ${host}`)
  client.subscribe([requestTopic, reportTopic], { qos: 0 }, (err) => {
    if (err) console.error('Subscribe error:', err)
    else console.log(`✓ Listening on:\n  → ${requestTopic}\n  ← ${reportTopic}\n`)
    console.log('Waiting for messages... Press the button in Bambu Studio now.\n')
  })
})

client.on('message', (topic, raw) => {
  const dir = topic.includes('/request') ? '→ REQUEST' : '← REPORT'
  const ts = new Date().toISOString().slice(11, 23)
  try {
    const data = JSON.parse(raw.toString())
    // For report messages, only show the top-level keys + any command fields
    // to avoid flooding with full status dumps
    if (topic.includes('/report')) {
      const summary = {}
      for (const [key, val] of Object.entries(data)) {
        if (typeof val === 'object' && val !== null) {
          const inner = val
          summary[key] = {
            command: inner.command ?? undefined,
            msg: inner.msg ?? undefined,
            sequence_id: inner.sequence_id ?? undefined,
            // Include a few useful fields if present
            ...(inner.gcode_state ? { gcode_state: inner.gcode_state } : {}),
            ...(inner.stg_cur ? { stg_cur: inner.stg_cur } : {}),
            _keys: Object.keys(inner).length + ' fields'
          }
        } else {
          summary[key] = val
        }
      }
      console.log(`[${ts}] ${dir}:`, JSON.stringify(summary, null, 2))
    } else {
      console.log(`[${ts}] ${dir}:`, JSON.stringify(data, null, 2))
    }
  } catch {
    console.log(`[${ts}] ${dir}: (raw)`, raw.toString().slice(0, 200))
  }
})

client.on('error', (err) => console.error('MQTT error:', err.message))
client.on('close', () => console.log('Connection closed'))
