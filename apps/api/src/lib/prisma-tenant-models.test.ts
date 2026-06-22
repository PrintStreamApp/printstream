import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Prisma } from '@prisma/client'
import { TENANT_SCOPED_EXCEPTION_MODELS, TENANT_SCOPED_MODELS } from './prisma.js'

/** Model names that carry a scalar `tenantId` column, read from the generated DMMF. */
function modelsWithTenantId(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === 'tenantId'))
    .map((model) => model.name)
}

test('every model with a tenantId is classified (auto-scoped or documented exception)', () => {
  const classified = new Set([...TENANT_SCOPED_MODELS, ...TENANT_SCOPED_EXCEPTION_MODELS])
  const unclassified = modelsWithTenantId().filter((name) => !classified.has(name))
  // If this fails, a new tenantId model was added without deciding whether the
  // scoping extension can auto-scope it (-> TENANT_SCOPED_MODELS) or it must be
  // hand-scoped (-> TENANT_SCOPED_EXCEPTION_MODELS, with rationale). Do not leave
  // it unscoped — that is a cross-tenant leak.
  assert.deepEqual(unclassified, [], `Unclassified tenantId models: ${unclassified.join(', ') || '(none)'}`)
})

test('the auto-scoped set and the exception set are disjoint', () => {
  const overlap = [...TENANT_SCOPED_MODELS].filter((name) => TENANT_SCOPED_EXCEPTION_MODELS.has(name))
  assert.deepEqual(overlap, [])
})

test('every classified model actually has a tenantId column (no stale entries)', () => {
  const tenantIdModels = new Set(modelsWithTenantId())
  for (const name of [...TENANT_SCOPED_MODELS, ...TENANT_SCOPED_EXCEPTION_MODELS]) {
    assert.ok(tenantIdModels.has(name), `${name} is listed as tenant-bound but has no tenantId column`)
  }
})
