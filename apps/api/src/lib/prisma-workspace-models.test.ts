import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { WORKSPACE_SCOPED_EXCEPTION_MODELS, WORKSPACE_SCOPED_MODELS } from './prisma.js'

/** Model names that carry a scalar `workspaceId` column, read from the generated DMMF. */
function modelsWithWorkspaceId(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'workspaceId'))
    .map((model) => model.name)
}

test('every model with a workspaceId is classified (auto-scoped or documented exception)', () => {
  const classified = new Set([...WORKSPACE_SCOPED_MODELS, ...WORKSPACE_SCOPED_EXCEPTION_MODELS])
  const unclassified = modelsWithWorkspaceId().filter((name) => !classified.has(name))
  // If this fails, a new workspaceId model was added without deciding whether the
  // scoping extension can auto-scope it (-> WORKSPACE_SCOPED_MODELS) or it must be
  // hand-scoped (-> WORKSPACE_SCOPED_EXCEPTION_MODELS, with rationale). Do not leave
  // it unscoped — that is a cross-workspace leak.
  assert.deepEqual(unclassified, [], `Unclassified workspaceId models: ${unclassified.join(', ') || '(none)'}`)
})

test('the auto-scoped set and the exception set are disjoint', () => {
  const overlap = [...WORKSPACE_SCOPED_MODELS].filter((name) => WORKSPACE_SCOPED_EXCEPTION_MODELS.has(name))
  assert.deepEqual(overlap, [])
})

test('every classified model actually has a workspaceId column (no stale entries)', () => {
  const workspaceIdModels = new Set(modelsWithWorkspaceId())
  for (const name of [...WORKSPACE_SCOPED_MODELS, ...WORKSPACE_SCOPED_EXCEPTION_MODELS]) {
    assert.ok(workspaceIdModels.has(name), `${name} is listed as workspace-bound but has no workspaceId column`)
  }
})
