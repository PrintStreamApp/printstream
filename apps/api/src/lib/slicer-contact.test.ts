/**
 * The lost-slice watchdog (see slicer-contact.ts). Before it, a slice whose slicer had restarted
 * kept appending its healthy "Slicing..." heartbeat until the 30-minute request ceiling, because the
 * progress poller collapsed every failure into "nothing new".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  INITIAL_SLICER_CONTACT,
  UNKNOWN_JOB_GRACE_MS,
  UNREACHABLE_GRACE_MS,
  nextSlicerContact,
  slicerContactGiveUpMessage,
  slicerContactHeartbeat,
  slicerContactLostForMs
} from './slicer-contact.js'

const output = { kind: 'output', lines: [] } as { kind: 'output'; lines: [] }
const unknown = { kind: 'unknown' } as const
const unclaimed = { kind: 'unclaimed' } as const
const unreachable = { kind: 'unreachable', reason: 'fetch failed' } as const

test('a job the slicer disowns is given up on after the short grace', () => {
  let state = nextSlicerContact(INITIAL_SLICER_CONTACT, unknown, 1_000)
  assert.equal(state.kind, 'unknown')
  assert.equal(slicerContactGiveUpMessage(state, 1_000), null)
  // Still within grace: the narrow race is a slice that just finished.
  state = nextSlicerContact(state, unknown, 1_000 + UNKNOWN_JOB_GRACE_MS - 1)
  assert.equal(slicerContactGiveUpMessage(state, 1_000 + UNKNOWN_JOB_GRACE_MS - 1), null)
  const message = slicerContactGiveUpMessage(state, 1_000 + UNKNOWN_JOB_GRACE_MS)
  assert.match(message ?? '', /slicer service restarted/i)
  assert.match(message ?? '', /Slice again/i)
})

test('an unreachable slicer gets a much longer grace than one that disowns the job', () => {
  let state = INITIAL_SLICER_CONTACT
  state = nextSlicerContact(state, unreachable, 0)
  // A restart blip must not kill a long slice.
  assert.equal(slicerContactGiveUpMessage(state, UNKNOWN_JOB_GRACE_MS + 1), null)
  assert.equal(slicerContactGiveUpMessage(state, UNREACHABLE_GRACE_MS - 1), null)
  assert.match(slicerContactGiveUpMessage(state, UNREACHABLE_GRACE_MS) ?? '', /Lost contact/i)
})

test('any answered poll clears the streak, so a blip never accumulates', () => {
  let state = nextSlicerContact(INITIAL_SLICER_CONTACT, unreachable, 0)
  state = nextSlicerContact(state, output, 5_000)
  assert.deepEqual(state, INITIAL_SLICER_CONTACT)
  assert.equal(slicerContactLostForMs(state, 10_000), 0)
  // A second, separate blip starts its own clock rather than resuming the first.
  state = nextSlicerContact(state, unreachable, 10_000)
  assert.equal(slicerContactGiveUpMessage(state, 10_000 + UNREACHABLE_GRACE_MS - 1), null)
})

test('unclaimed is neutral: it neither starts a streak nor clears one', () => {
  // A queued job has no instance yet, and a finished one has just been released. Treating either
  // as a lost slice would fail every job before it started.
  assert.deepEqual(nextSlicerContact(INITIAL_SLICER_CONTACT, unclaimed, 1_000), INITIAL_SLICER_CONTACT)
  assert.equal(slicerContactGiveUpMessage(nextSlicerContact(INITIAL_SLICER_CONTACT, unclaimed, 1_000), 10 * 60_000), null)

  const lost = nextSlicerContact(INITIAL_SLICER_CONTACT, unknown, 0)
  const stillLost = nextSlicerContact(lost, unclaimed, 5_000)
  assert.equal(stillLost.lostSince, 0, 'an unclaimed poll must not reset the clock')
})

test('a streak that changes kind restarts the clock on the new kind', () => {
  // Unreachable (service down) settling into unknown (service back, job gone) is the ordinary
  // restart sequence: judge it on the short unknown grace from when the instance came back.
  let state = nextSlicerContact(INITIAL_SLICER_CONTACT, unreachable, 0)
  state = nextSlicerContact(state, unknown, 30_000)
  assert.equal(state.lostSince, 30_000)
  assert.equal(slicerContactGiveUpMessage(state, 30_000 + UNKNOWN_JOB_GRACE_MS - 1), null)
  assert.match(slicerContactGiveUpMessage(state, 30_000 + UNKNOWN_JOB_GRACE_MS) ?? '', /restarted/i)
})

test('the heartbeat never claims progress once contact is lost', () => {
  assert.match(slicerContactHeartbeat(INITIAL_SLICER_CONTACT, 0, '2m'), /^Slicing\.\.\. 2m elapsed$/)

  const disowned = nextSlicerContact(INITIAL_SLICER_CONTACT, unknown, 0)
  const disownedLine = slicerContactHeartbeat(disowned, 4_000, '2m')
  assert.doesNotMatch(disownedLine, /^Slicing\.\.\./)
  assert.match(disownedLine, /no longer tracking this job \(4s\)/)

  const offline = nextSlicerContact(INITIAL_SLICER_CONTACT, unreachable, 0)
  const offlineLine = slicerContactHeartbeat(offline, 7_000, '2m')
  assert.doesNotMatch(offlineLine, /^Slicing\.\.\./)
  assert.match(offlineLine, /Lost contact with the slicer service \(7s\)/)
})
