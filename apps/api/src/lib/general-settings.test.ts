import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_APP_LANDING_PAGE } from '@printstream/shared'
import { clearPrintersDefaultViewIdIfMatches, getGeneralSettings, updateGeneralSettings } from './general-settings.js'
import { listAllWorkspaceSupportPermissions } from './support-access.js'
import { withWorkspaceRequestContext } from './workspace-context.js'

test('getGeneralSettings defaults unconstrained width off when unset', async () => {
  const settings = await getGeneralSettings({
    async findUnique() {
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: false,
    slicerDeveloperMode: false,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    printersDefaultViewId: null,
    navTabOrder: [],
    quickStartDismissed: false,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions(),
    editorShowBedModel: true,
    editorSidebarSide: 'right'
  })
})

test('getGeneralSettings reads a persisted unconstrained width flag', async () => {
  const settings = await getGeneralSettings({
    async findUnique(args) {
      if (args.where.key.endsWith('app:general:unconstrainedWidth')) {
        return { value: 'true' }
      }
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    slicerDeveloperMode: false,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    printersDefaultViewId: null,
    navTabOrder: [],
    quickStartDismissed: false,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions(),
    editorShowBedModel: true,
    editorSidebarSide: 'right'
  })
})

test('updateGeneralSettings upserts the shared unconstrained width flag', async () => {
  let receivedArgs: unknown = null
  const settings = await updateGeneralSettings({ unconstrainedWidth: true }, {
    async findUnique() {
      return null
    },
    async upsert(args) {
      receivedArgs = args
      return { key: 'app:general:unconstrainedWidth', value: 'true' }
    }
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    slicerDeveloperMode: false,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    printersDefaultViewId: null,
    navTabOrder: [],
    quickStartDismissed: false,
    supportAccessEnabled: true,
    supportAccessPermissions: listAllWorkspaceSupportPermissions(),
    editorShowBedModel: true,
    editorSidebarSide: 'right'
  })
  assert.deepEqual(receivedArgs, {
    where: { key: 'platform:app:general:unconstrainedWidth' },
    create: { key: 'platform:app:general:unconstrainedWidth', value: 'true' },
    update: { value: 'true' }
  })
})

test('updateGeneralSettings writes support access policy in workspace scope without resetting other values', async () => {
  const upserts: unknown[] = []

  const settings = await withWorkspaceRequestContext({ id: 'workspace-1', slug: 'alpha', name: 'Alpha' }, async () => {
    return await updateGeneralSettings({
      supportAccessEnabled: false,
      supportAccessPermissions: ['printers.view', 'jobs.view'],
      editorShowBedModel: true,
      editorSidebarSide: 'right'
    }, {
      async findUnique(args) {
        if (args.where.key === 'workspace:workspace-1:app:general:unconstrainedWidth') {
          return { value: 'true' }
        }
        return null
      },
      async upsert(args) {
        upserts.push(args)
        return { key: args.where.key, value: args.update.value }
      }
    })
  })

  assert.deepEqual(settings, {
    appTheme: 'default',
    unconstrainedWidth: true,
    slicerDeveloperMode: false,
    landingPage: DEFAULT_APP_LANDING_PAGE,
    printersDefaultViewId: null,
    navTabOrder: [],
    quickStartDismissed: false,
    supportAccessEnabled: false,
    supportAccessPermissions: ['printers.view', 'jobs.view'],
    editorShowBedModel: true,
    editorSidebarSide: 'right'
  })
  assert.deepEqual(upserts, [
    {
      where: { key: 'workspace:workspace-1:auth:supportAccessEnabled' },
      create: { key: 'workspace:workspace-1:auth:supportAccessEnabled', value: 'false' },
      update: { value: 'false' }
    },
    {
      where: { key: 'workspace:workspace-1:auth:supportAccessPermissions' },
      create: { key: 'workspace:workspace-1:auth:supportAccessPermissions', value: '["printers.view","jobs.view"]' },
      update: { value: '["printers.view","jobs.view"]' }
    }
  ])
})
test('updateGeneralSettings persists the quick start dismissal', async () => {
  const upserts: Array<{ key: string; value: string }> = []
  const settings = await updateGeneralSettings({ quickStartDismissed: true }, {
    async findUnique() {
      return null
    },
    async upsert(args) {
      upserts.push({ key: args.where.key, value: args.update.value })
      return {}
    }
  })

  assert.equal(settings.quickStartDismissed, true)
  assert.equal(upserts.length, 1)
  const upsert = upserts[0]
  assert.ok(upsert != null && upsert.key.endsWith('app:general:quickStartDismissed'))
  assert.equal(upsert?.value, 'true')
})

test('updateGeneralSettings upserts the shared slicer developer mode flag', async () => {
  const upserts: Array<{ key: string; value: string }> = []
  const settings = await updateGeneralSettings({ slicerDeveloperMode: true }, {
    async findUnique() {
      return null
    },
    async upsert(args) {
      upserts.push({ key: args.where.key, value: args.update.value })
      return {}
    }
  })

  assert.equal(settings.slicerDeveloperMode, true)
  assert.equal(upserts.length, 1)
  const upsert = upserts[0]
  assert.ok(upsert != null && upsert.key.endsWith('app:general:slicerDeveloperMode'))
  assert.equal(upsert?.value, 'true')
})

test('getGeneralSettings reads a persisted slicer developer mode flag', async () => {
  const settings = await getGeneralSettings({
    async findUnique(args) {
      if (args.where.key.endsWith('app:general:slicerDeveloperMode')) {
        return { value: 'true' }
      }
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.equal(settings.slicerDeveloperMode, true)
})

test('getGeneralSettings reads a persisted default printer view, treating the empty clear-marker as none', async () => {
  const readValue = async (stored: string | null) => (await getGeneralSettings({
    async findUnique(args) {
      if (args.where.key.endsWith('app:general:printersDefaultViewId') && stored !== null) {
        return { value: stored }
      }
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })).printersDefaultViewId

  assert.equal(await readValue('clviewid1234'), 'clviewid1234')
  // '' is how a cleared default is stored (the store interface cannot delete).
  assert.equal(await readValue(''), null)
  assert.equal(await readValue(null), null)
})

test('updateGeneralSettings upserts the default printer view and clears it as the empty marker', async () => {
  const upserts: Array<{ key: string; value: string }> = []
  const store = {
    async findUnique() {
      return null
    },
    async upsert(args: { where: { key: string }; update: { value: string } }) {
      upserts.push({ key: args.where.key, value: args.update.value })
      return {}
    }
  }

  const set = await updateGeneralSettings({ printersDefaultViewId: 'clviewid1234' }, store)
  assert.equal(set.printersDefaultViewId, 'clviewid1234')
  const cleared = await updateGeneralSettings({ printersDefaultViewId: null }, store)
  assert.equal(cleared.printersDefaultViewId, null)

  assert.equal(upserts.length, 2)
  assert.ok(upserts[0]?.key.endsWith('app:general:printersDefaultViewId'))
  assert.equal(upserts[0]?.value, 'clviewid1234')
  assert.equal(upserts[1]?.value, '')
})

test('clearPrintersDefaultViewIdIfMatches clears only a matching stored default', async () => {
  const run = async (stored: string | null, deletedViewId: string) => {
    const upserts: Array<{ value: string }> = []
    await clearPrintersDefaultViewIdIfMatches(deletedViewId, {
      async findUnique() {
        return stored === null ? null : { value: stored }
      },
      async upsert(args) {
        upserts.push({ value: args.update.value })
        return {}
      }
    })
    return upserts
  }

  assert.deepEqual(await run('clviewid1234', 'clviewid1234'), [{ value: '' }])
  assert.deepEqual(await run('clotherview', 'clviewid1234'), [])
  assert.deepEqual(await run(null, 'clviewid1234'), [])
})

test('getGeneralSettings reads a persisted quick start dismissal', async () => {
  const settings = await getGeneralSettings({
    async findUnique(args) {
      if (args.where.key.endsWith('app:general:quickStartDismissed')) {
        return { value: 'true' }
      }
      return null
    },
    async upsert() {
      throw new Error('upsert should not be called')
    }
  })

  assert.equal(settings.quickStartDismissed, true)
})
