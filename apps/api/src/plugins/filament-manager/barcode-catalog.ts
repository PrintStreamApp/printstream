/**
 * Server-local barcode lookup for the filament manager.
 *
 * The Open Filament Database publishes one complete JSON catalog. PrintStream downloads that
 * catalog at most once per day, builds GTIN and manufacturer article-number indexes in memory,
 * and resolves scans locally. A scanned code is never sent to the upstream service. Refreshes are
 * bounded by time and response size, and an expired working catalog remains usable if the upstream
 * is temporarily unavailable.
 */
import type { FilamentBarcodeProduct } from '@printstream/shared'
import type { PluginLogger } from '../../plugin/types.js'

const OPEN_FILAMENT_DATABASE_URL = 'https://api.openfilamentdatabase.org/json/all.json'
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000
const MAX_CATALOG_BYTES = 16 * 1024 * 1024

type UnknownRecord = Record<string, unknown>

interface BarcodeCatalogIndex {
  /** Null marks a code that the upstream catalog assigns to conflicting products. */
  gtins: Map<string, FilamentBarcodeProduct | null>
  /** Null marks a code that the upstream catalog assigns to conflicting products. */
  articles: Map<string, FilamentBarcodeProduct | null>
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function records(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is UnknownRecord => entry != null) : []
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integer(value: unknown): number | null {
  const number = finiteNumber(value)
  return number == null ? null : Math.round(number)
}

function normalizeHex(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value
  const normalized = text(candidate)?.toUpperCase() ?? null
  return normalized && /^#[0-9A-F]{6}$/.test(normalized) ? normalized : null
}

/** Make UPC-A and its leading-zero EAN-13 representation resolve to the same GTIN. */
export function canonicalizeFilamentGtin(code: string): string {
  const digits = code.replace(/\D/g, '')
  return digits.replace(/^0+/, '') || '0'
}

function materialSubtype(name: string | null, material: string): string | null {
  if (!name) return null
  const withoutMaterial = name.replace(new RegExp(`\\b${material.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '')
  return withoutMaterial.replace(/\s+/g, ' ').replace(/^[\s+-]+|[\s+-]+$/g, '') || null
}

/**
 * Decide whether duplicate catalog rows describe the same prefill values.
 *
 * Packaging-only differences such as spool core weight are safe to collapse because one product
 * code can cover both a spooled unit and a refill. Identity differences must not be guessed from
 * catalog ordering.
 */
function productsHaveEquivalentIdentity(left: FilamentBarcodeProduct, right: FilamentBarcodeProduct): boolean {
  return left.brand === right.brand
    && left.filamentType === right.filamentType
    && left.materialSubtype === right.materialSubtype
    && left.colorName === right.colorName
    && left.colorHex === right.colorHex
    && left.diameterMm === right.diameterMm
    && left.netWeightGrams === right.netWeightGrams
}

/** Keep only optional package/profile values that every equivalent catalog row agrees on. */
function mergeEquivalentProducts(
  left: FilamentBarcodeProduct,
  right: FilamentBarcodeProduct
): FilamentBarcodeProduct {
  return {
    ...left,
    spoolCoreGrams: left.spoolCoreGrams === right.spoolCoreGrams ? left.spoolCoreGrams : null,
    nozzleTempMin: left.nozzleTempMin === right.nozzleTempMin ? left.nozzleTempMin : null,
    nozzleTempMax: left.nozzleTempMax === right.nozzleTempMax ? left.nozzleTempMax : null,
    // A shared code cannot prove the package is a refill unless every matching row says it is.
    refill: left.refill && right.refill
  }
}

/** Add one code while preserving ambiguity instead of allowing a later row to win silently. */
function indexProduct(
  index: Map<string, FilamentBarcodeProduct | null>,
  code: string,
  product: FilamentBarcodeProduct
): void {
  if (!index.has(code)) {
    index.set(code, product)
    return
  }

  const existing = index.get(code)
  if (!existing) return
  if (!productsHaveEquivalentIdentity(existing, product)) {
    index.set(code, null)
    return
  }
  index.set(code, mergeEquivalentProducts(existing, product))
}

/** Build the two lookup indexes from an Open Filament Database `all.json` payload. */
export function buildBarcodeCatalogIndex(payload: unknown): BarcodeCatalogIndex {
  const root = asRecord(payload)
  if (!root) throw new Error('Open Filament Database returned an invalid catalog')

  const brands = new Map(records(root.brands).flatMap((brand) => {
    const id = text(brand.id)
    return id ? [[id, brand] as const] : []
  }))
  const filaments = new Map(records(root.filaments).flatMap((filament) => {
    const id = text(filament.id)
    return id ? [[id, filament] as const] : []
  }))
  const variants = new Map(records(root.variants).flatMap((variant) => {
    const id = text(variant.id)
    return id ? [[id, variant] as const] : []
  }))

  const gtins = new Map<string, FilamentBarcodeProduct | null>()
  const articles = new Map<string, FilamentBarcodeProduct | null>()
  for (const size of records(root.sizes)) {
    const gtin = text(size.gtin)
    const article = text(size.article_number)
    if (!gtin && !article) continue

    const variant = variants.get(text(size.variant_id) ?? '')
    const filament = variant ? filaments.get(text(variant.filament_id) ?? '') : null
    if (!variant || !filament) continue

    const material = text(filament.material)
    if (!material) continue
    const brand = brands.get(text(filament.brand_id) ?? '')
    const brandName = text(brand?.name)
    const filamentName = text(filament.name)
    const colorName = text(variant.name)
    const productCode = gtin ?? article!
    const product: FilamentBarcodeProduct = {
      title: [brandName, filamentName, colorName].filter(Boolean).join(' '),
      productCode,
      brand: brandName,
      filamentType: material,
      materialSubtype: materialSubtype(filamentName, material),
      colorName,
      colorHex: normalizeHex(variant.color_hex),
      diameterMm: finiteNumber(size.diameter),
      netWeightGrams: integer(size.filament_weight),
      spoolCoreGrams: integer(size.empty_spool_weight),
      nozzleTempMin: integer(filament.min_print_temperature),
      nozzleTempMax: integer(filament.max_print_temperature),
      refill: size.spool_refill === true
    }

    if (gtin) indexProduct(gtins, canonicalizeFilamentGtin(gtin), { ...product, productCode: gtin })
    if (article) indexProduct(articles, article.toUpperCase(), { ...product, productCode: article })
  }

  if (gtins.size === 0 && articles.size === 0) {
    throw new Error('Open Filament Database catalog contained no product codes')
  }
  return { gtins, articles }
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CATALOG_BYTES) {
    throw new Error('Open Filament Database catalog exceeds the response limit')
  }
  if (!response.body) throw new Error('Open Filament Database returned an empty response')

  const chunks: Uint8Array[] = []
  const reader = response.body.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_CATALOG_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('Open Filament Database catalog exceeds the response limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** Lazily cached catalog client. One instance belongs to the plugin lifecycle. */
export class FilamentBarcodeCatalog {
  private index: BarcodeCatalogIndex | null = null
  private expiresAt = 0
  private refreshPromise: Promise<BarcodeCatalogIndex> | null = null

  constructor(
    private readonly logger: Pick<PluginLogger, 'warn'>,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  /** Resolve a uniquely identified retail GTIN or article number; unknown or ambiguous codes return null. */
  async lookup(rawCode: string): Promise<FilamentBarcodeProduct | null> {
    const code = rawCode.trim()
    const index = await this.loadIndex()
    const gtinKey = /^\d{8,14}$/.test(code) ? canonicalizeFilamentGtin(code) : null
    const product = gtinKey && index.gtins.has(gtinKey)
      ? index.gtins.get(gtinKey)
      : index.articles.get(code.toUpperCase())
    return product ? { ...product, productCode: code } : null
  }

  private async loadIndex(): Promise<BarcodeCatalogIndex> {
    if (this.index && Date.now() < this.expiresAt) return this.index
    if (this.refreshPromise) return this.refreshPromise

    this.refreshPromise = this.refresh().catch((error) => {
      if (this.index) {
        this.logger.warn('Could not refresh the filament barcode catalog; using the previous copy', error)
        this.expiresAt = Date.now() + CATALOG_TTL_MS
        return this.index
      }
      throw error
    }).finally(() => {
      this.refreshPromise = null
    })
    return this.refreshPromise
  }

  private async refresh(): Promise<BarcodeCatalogIndex> {
    const response = await this.fetchImpl(OPEN_FILAMENT_DATABASE_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'PrintStream filament-manager plugin' }
    })
    if (!response.ok) throw new Error(`Open Filament Database returned HTTP ${response.status}`)
    const index = buildBarcodeCatalogIndex(await readJsonWithLimit(response))
    this.index = index
    this.expiresAt = Date.now() + CATALOG_TTL_MS
    return index
  }
}
