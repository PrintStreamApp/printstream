/** Regression coverage for local filament barcode indexing and catalog caching. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FilamentBarcodeCatalog, buildBarcodeCatalogIndex, canonicalizeFilamentGtin } from './barcode-catalog.js'

const CATALOG = {
  brands: [{ id: 'brand-bambu', name: 'Bambu Lab' }],
  filaments: [{
    id: 'filament-abs',
    brand_id: 'brand-bambu',
    name: 'ABS',
    material: 'ABS',
    min_print_temperature: 240,
    max_print_temperature: 270
  }],
  variants: [{
    id: 'variant-black',
    filament_id: 'filament-abs',
    name: 'Black',
    color_hex: '#000000'
  }],
  sizes: [{
    variant_id: 'variant-black',
    gtin: '06975337032878',
    article_number: '40101',
    filament_weight: 1000,
    diameter: 1.75,
    empty_spool_weight: 250,
    spool_refill: false
  }]
}

test('canonicalizes equivalent UPC-A and EAN-13/GTIN representations', () => {
  assert.equal(canonicalizeFilamentGtin('0 6975337032878'), '6975337032878')
  assert.equal(canonicalizeFilamentGtin('06975337032878'), '6975337032878')
})

test('indexes Bambu retail and five-digit article codes', () => {
  const index = buildBarcodeCatalogIndex(CATALOG)
  assert.equal(index.gtins.get('6975337032878')?.title, 'Bambu Lab ABS Black')
  assert.equal(index.articles.get('40101')?.filamentType, 'ABS')
  assert.equal(index.articles.get('40101')?.colorHex, '#000000')
})

test('rejects a code assigned to products with different prefill values', () => {
  const conflictingCatalog = {
    ...CATALOG,
    variants: [
      ...CATALOG.variants,
      {
        id: 'variant-white',
        filament_id: 'filament-abs',
        name: 'White',
        color_hex: '#FFFFFF'
      }
    ],
    sizes: [
      ...CATALOG.sizes,
      {
        ...CATALOG.sizes[0],
        variant_id: 'variant-white'
      }
    ]
  }

  const index = buildBarcodeCatalogIndex(conflictingCatalog)
  assert.equal(index.gtins.get('6975337032878'), null)
  assert.equal(index.articles.get('40101'), null)
})

test('collapses duplicate package rows when their spool prefill values agree', () => {
  const packageCatalog = {
    ...CATALOG,
    sizes: [
      ...CATALOG.sizes,
      {
        ...CATALOG.sizes[0],
        empty_spool_weight: null,
        spool_refill: true
      }
    ]
  }

  const index = buildBarcodeCatalogIndex(packageCatalog)
  assert.equal(index.gtins.get('6975337032878')?.colorName, 'Black')
  assert.equal(index.gtins.get('6975337032878')?.spoolCoreGrams, null)
  assert.equal(index.articles.get('40101')?.filamentType, 'ABS')
})

test('lookup refuses an ambiguous catalog code instead of selecting by row order', async () => {
  const conflictingCatalog = {
    ...CATALOG,
    variants: [
      ...CATALOG.variants,
      {
        id: 'variant-white',
        filament_id: 'filament-abs',
        name: 'White',
        color_hex: '#FFFFFF'
      }
    ],
    sizes: [
      ...CATALOG.sizes,
      {
        ...CATALOG.sizes[0],
        variant_id: 'variant-white'
      }
    ]
  }
  const catalog = new FilamentBarcodeCatalog(
    { warn() {} },
    async () => new Response(JSON.stringify(conflictingCatalog), { status: 200 })
  )

  assert.equal(await catalog.lookup('6975337032878'), null)
  assert.equal(await catalog.lookup('40101'), null)
})

test('downloads once, resolves both code forms, and reports unknown codes', async () => {
  let requests = 0
  const catalog = new FilamentBarcodeCatalog(
    { warn() {} },
    async () => {
      requests += 1
      return new Response(JSON.stringify(CATALOG), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  )

  const retail = await catalog.lookup('6975337032878')
  const article = await catalog.lookup('40101')
  assert.equal(retail?.brand, 'Bambu')
  assert.equal(retail?.productCode, '6975337032878')
  assert.equal(article?.productCode, '40101')
  assert.equal(await catalog.lookup('not-known'), null)
  assert.equal(requests, 1)
})

test('barcode prefills retain the full product line used by calibration matching', () => {
  for (const [brand, name, material, expected] of [
    ['Polymaker', 'PolyLite PETG', 'PETG', 'PolyLite PETG'],
    ['Bambu Lab', 'PLA Metal', 'PLA', 'PLA Metal'],
    ['Polymaker', 'Polymaker PolyLite PETG', 'PETG', 'PolyLite PETG']
  ]) {
    const index = buildBarcodeCatalogIndex({
      ...CATALOG,
      brands: [{ ...CATALOG.brands[0], name: brand }],
      filaments: [{ ...CATALOG.filaments[0], name, material }]
    })
    assert.equal(index.articles.get('40101')?.materialSubtype, expected)
  }
})
