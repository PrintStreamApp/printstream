/** Surviving-runtime admission is based on observed ownership, never port availability alone. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { qualifyDevResume, runDevResume } from './dev-resume.mjs'

const state = {
  config: { infraDir: '/config/infra' },
  project: { database: { engine: 'postgres', version: '16.13-bookworm', hostAccess: true } },
  identity: { composeProject: 'printstream', slug: 'printstream' },
  ports: { web: 22070, api: 22071 },
  url: 'http://printstream.localhost'
}
const options = { repoRoot: '/repo', remoteSlicer: true, devkitPackageRoot: '/devkit', resolvePath: (file) => file }

function fixtures() {
  return ['node', 'database', 'slicer'].map((service) => ({
    Id: `exact-${service}`,
    State: { Running: true, Health: { Status: 'healthy' } },
    Config: {
      Image: 'postgres:16.13-bookworm',
      Labels: {
        'com.docker.compose.project': 'printstream',
        'com.docker.compose.service': service,
        'com.docker.compose.oneoff': 'False',
        'com.docker.compose.project.working_dir': '/repo',
        'com.docker.compose.project.config_files': '/config/infra/postgres.yml,/devkit/infra/database-host.yml,/repo/compose.dev.yml'
      },
      Cmd: ['node', 'scripts/dev/run-dev.mjs', '--container-runtime'],
      Env: ['PRINTSTREAM_DEV_BRIDGE=host', 'DEVKIT_COMPOSE_PROJECT=printstream']
    },
    Mounts: service === 'database'
      ? [{ Type: 'volume', Name: 'printstream-database' }]
      : [{ Destination: '/workspace', Type: 'bind', Source: '/repo' }],
    NetworkSettings: { Networks: { printstream_default: {} }, Ports: service === 'node' ? {
      '5173/tcp': [{ HostIp: '127.0.0.1', HostPort: '22070' }, { HostIp: '::1', HostPort: '22070' }],
      '4000/tcp': [{ HostIp: '127.0.0.1', HostPort: '22071' }]
    } : {} }
  }))
}

test('qualifies exact surviving checkout without changing the observed runtime', () => {
  const containers = fixtures()
  const before = structuredClone(containers)
  assert.deepEqual(qualifyDevResume(state, containers, options), { nodeId: 'exact-node' })
  assert.deepEqual(containers, before)
})

test('accepts authentic infra-provisioned database labels without accepting foreign data/network', () => {
  const rows = fixtures()
  const database = rows[1]
  database.Config.Labels['com.docker.compose.project.working_dir'] = '/config/infra'
  database.Config.Labels['com.docker.compose.project.config_files'] = '/config/infra/postgres.yml,/devkit/infra/database-host.yml'
  assert.deepEqual(qualifyDevResume(state, rows, options), { nodeId: 'exact-node' })
  for (const mutation of [
    (row) => { row.Config.Image = 'postgres:latest' },
    (row) => { row.Mounts[0].Name = 'foreign-database' },
    (row) => { row.NetworkSettings.Networks = { foreign_default: {} } },
    (row) => { row.Config.Labels['com.docker.compose.project.working_dir'] = '/foreign/infra' }
  ]) {
    const changed = structuredClone(rows)
    mutation(changed[1])
    assert.throws(() => qualifyDevResume(state, changed, options), /differs|match/)
  }
})

test('foreign checkout, duplicate service, overrides and wrong mounts never qualify', () => {
  const mutations = [
    (rows) => { rows[0].Config.Labels['com.docker.compose.project'] = 'foreign' },
    (rows) => { rows.push(structuredClone(rows[0])) },
    (rows) => { rows[0].Config.Labels['com.docker.compose.project.config_files'] += ',/foreign/override.yml' },
    (rows) => { rows[0].Mounts[0].Source = '/foreign' },
    (rows) => { rows[0].Config.Cmd = ['node', 'something-else.mjs'] },
    (rows) => { rows[0].Config.Env[0] = 'PRINTSTREAM_DEV_BRIDGE=container' },
    (rows) => { rows[1].State.Health.Status = 'starting' },
    (rows) => { rows[2].State.Restarting = true },
    (rows) => { rows.pop() }
  ]
  for (const mutate of mutations) {
    const rows = fixtures()
    mutate(rows)
    assert.throws(() => qualifyDevResume(state, rows, options), /resume|surviving/)
  }
})

test('wrong, public or multiply owned published ports are refused', () => {
  for (const mutation of [
    (rows) => { rows[0].NetworkSettings.Ports['4000/tcp'][0].HostPort = '22072' },
    (rows) => { rows[0].NetworkSettings.Ports['5173/tcp'][0].HostIp = '0.0.0.0' },
    (rows) => { rows.push({ Id: 'foreign', NetworkSettings: { Ports: { '80/tcp': [{ HostPort: '22070' }] } } }) }
  ]) {
    const rows = fixtures()
    mutation(rows)
    assert.throws(() => qualifyDevResume(state, rows, options), /port|publishes/)
  }
})

function child() {
  const result = new EventEmitter()
  result.exitCode = null
  result.signalCode = null
  result.kill = (signal) => {
    result.signalCode = signal
    result.emit('exit', null, signal)
  }
  return result
}

test('resume spawns existing bridge and logs only; shutdown leaves containers and volumes alone', async () => {
  const calls = []
  const bridge = child()
  const logs = child()
  const processEvents = new EventEmitter()
  const runtime = {
    process: processEvents,
    spawn(command, args, opts) {
      calls.push({ command, args, opts })
      const result = calls.length === 1 ? bridge : logs
      queueMicrotask(() => {
        result.emit('spawn')
        if (result === logs) processEvents.emit('SIGINT')
      })
      return result
    }
  }
  const routes = []
  const exitCode = await runDevResume(state, { nodeId: 'exact-node' }, {
    repoRoot: '/repo', runtime,
    route: { writeRoute: () => routes.push('write'), removeRoute: () => routes.push('remove') }
  })
  assert.equal(exitCode, 130)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].opts.env.BRIDGE_SERVER_URL, 'http://127.0.0.1:22071')
  assert.deepEqual(calls[1].args, ['logs', '--follow', '--tail', '30', 'exact-node'])
  assert.deepEqual(routes, ['write', 'remove'])
  assert.equal(bridge.signalCode, 'SIGTERM')
  assert.equal(processEvents.listenerCount('SIGINT'), 0)
})

for (const failure of ['bridge-spawn', 'logs-error', 'bridge-exit', 'logs-clean-exit']) {
  test(`resume ${failure} fails and cleans only its own bridge/route`, async () => {
    const bridge = child()
    const logs = child()
    const calls = []
    const routes = []
    const processEvents = new EventEmitter()
    const runtime = {
      process: processEvents,
      spawn(command, args) {
        calls.push({ command, args })
        const result = calls.length === 1 ? bridge : logs
        queueMicrotask(() => {
          if (result === bridge) {
            if (failure === 'bridge-spawn') result.emit('error', new Error('bridge spawn failed'))
            else result.emit('spawn')
            return
          }
          result.emit('spawn')
          if (failure === 'logs-error') result.emit('error', new Error('logs failed'))
          if (failure === 'bridge-exit') {
            bridge.exitCode = 2
            bridge.emit('exit', 2, null)
          }
          if (failure === 'logs-clean-exit') {
            logs.exitCode = 0
            logs.emit('exit', 0, null)
          }
        })
        return result
      }
    }
    const running = runDevResume(state, { nodeId: 'exact-node' }, {
      repoRoot: '/repo', runtime,
      route: { writeRoute: () => routes.push('write'), removeRoute: () => routes.push('remove') }
    })
    if (['bridge-spawn', 'logs-error'].includes(failure)) {
      await assert.rejects(running, /failed/)
    } else {
      assert.equal(await running, 1)
    }
    assert.deepEqual(routes, failure === 'bridge-spawn' ? [] : ['write', 'remove'])
    assert.equal(bridge.exitCode !== null || bridge.signalCode === 'SIGTERM', true)
    assert.equal(processEvents.listenerCount('SIGINT'), 0)
    assert.equal(calls.some((call) => call.args.includes('compose')), false)
  })
}
