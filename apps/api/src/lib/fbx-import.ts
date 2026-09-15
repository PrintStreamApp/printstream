/**
 * Server-side FBX loading. The maintained Three.js loader owns the format grammar; the shared
 * `mesh-fbx-scene.ts` counterpart owns conversion into PrintStream's dependency-free mesh contract.
 *
 * Loaded lazily because Three.js is substantial and the API must not pay its startup cost unless a
 * user actually imports FBX. Image loading remains inert during Three.js parsing; embedded diffuse
 * textures are decoded deliberately afterwards and handed to the shared scene converter.
 */
import {
  ModelImportError,
  importedMeshFromFbxScene,
  prepareFbxLoaderBytes,
  readFbxUnitScaleFactor,
  referencedFbxTextures,
  MAX_MODEL_TEXTURE_PIXELS,
  type DecodedTextureImage,
  type FbxSceneNode,
  type FbxSceneTexture,
  type ImportedMesh
} from '@printstream/shared/three-mf'
import { decodeTextureImage } from './texture-image.js'

/** Parse one FBX file into the editor's millimetre triangle-mesh contract. */
export async function parseFbxMesh(
  buffer: Uint8Array,
  options: { sourceAppearance?: boolean } = {}
): Promise<ImportedMesh> {
  try {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js')
    const loaded = withInertImageEnvironment(
      () => new FBXLoader().parse(tightArrayBuffer(prepareFbxLoaderBytes(buffer)), '')
    )
    const root = loaded.value
    root.updateMatrixWorld(true)
    const decodedTextures = options.sourceAppearance === false
      ? undefined
      : await decodeFbxTextures(root, loaded.objectUrls)
    return importedMeshFromFbxScene(root, readFbxUnitScaleFactor(buffer), { decodedTextures })
  } catch (error) {
    if (error instanceof ModelImportError) throw error
    throw new ModelImportError(error instanceof Error && error.message
      ? `FBX could not be imported: ${error.message.replace(/^THREE\.FBXLoader:\s*/i, '')}`
      : 'FBX could not be imported')
  }
}

function tightArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Three's geometry loader also constructs Texture placeholders. Node has Blob and object URLs but
 * no DOM image element, so provide the smallest inert image surface for the synchronous parse.
 * The globals are restored before this function returns; no `await` occurs inside the mutation.
 */
function withInertImageEnvironment<T>(operation: () => T): { value: T; objectUrls: Map<string, Blob> } {
  const globals = globalThis as unknown as { document?: Document; window?: { URL: typeof URL } }
  const previousDocument = globals.document
  const previousWindow = globals.window
  const previousCreateElementNs = previousDocument?.createElementNS
  const urlConstructor = globalThis.URL
  const previousCreateObjectUrl = urlConstructor.createObjectURL
  const objectUrls = new Map<string, Blob>()
  let objectUrlSequence = 0
  class InertImage {
    private source = ''
    private readonly loadListeners = new Set<EventListenerOrEventListenerObject>()
    get src(): string { return this.source }
    set src(value: string) {
      this.source = value
      for (const listener of [...this.loadListeners]) {
        if (typeof listener === 'function') listener.call(this, {} as Event)
        else listener.handleEvent({} as Event)
      }
    }
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'load') this.loadListeners.add(listener)
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
      if (type === 'load') this.loadListeners.delete(listener)
    }
  }
  const createElementNS = ((namespace: string | null, qualifiedName: string) => qualifiedName.toLowerCase() === 'img'
    ? new InertImage()
    : previousCreateElementNs?.call(previousDocument, namespace, qualifiedName)) as typeof document.createElementNS
  if (previousDocument) previousDocument.createElementNS = createElementNS
  else globals.document = { createElementNS } as Document
  if (!previousWindow) globals.window = { URL: urlConstructor }
  urlConstructor.createObjectURL = (value) => {
    const url = `blob:printstream-fbx-${objectUrlSequence++}`
    if (value instanceof Blob) objectUrls.set(url, value)
    return url
  }
  try {
    return { value: operation(), objectUrls }
  } finally {
    if (previousDocument && previousCreateElementNs) previousDocument.createElementNS = previousCreateElementNs
    else delete globals.document
    if (!previousWindow) delete globals.window
    urlConstructor.createObjectURL = previousCreateObjectUrl
  }
}

/** Decode only diffuse textures referenced by mesh materials, rejecting unavailable sidecars. */
async function decodeFbxTextures(
  root: FbxSceneNode,
  objectUrls: ReadonlyMap<string, Blob>
): Promise<Map<object, DecodedTextureImage>> {
  const decoded = new Map<object, DecodedTextureImage>()
  let decodedPixels = 0
  for (const reference of referencedFbxTextures(root)) {
    const resource = await readFbxTextureResource(reference.source, objectUrls)
    const image = decodeTextureImage(resource.name, resource.bytes)
    decodedPixels += image.width * image.height
    if (decodedPixels > MAX_MODEL_TEXTURE_PIXELS) throw new ModelImportError('FBX textures exceed the decoded pixel limit')
    decoded.set(reference.texture as FbxSceneTexture, image)
  }
  return decoded
}

async function readFbxTextureResource(
  source: string,
  objectUrls: ReadonlyMap<string, Blob>
): Promise<{ name: string; bytes: Uint8Array }> {
  const blob = objectUrls.get(source)
  if (blob) return { name: textureName(blob.type), bytes: new Uint8Array(await blob.arrayBuffer()) }
  const match = /^data:(image\/(?:png|jpeg));base64,(.*)$/is.exec(source)
  if (match) {
    try {
      return { name: textureName(match[1]!), bytes: Uint8Array.from(Buffer.from(match[2]!, 'base64')) }
    } catch {
      throw new ModelImportError('FBX texture could not be read')
    }
  }
  throw new ModelImportError('This FBX refers to a separate texture file; embed its textures before importing')
}

function textureName(mimeType: string): string {
  if (mimeType === 'image/png') return 'texture.png'
  if (mimeType === 'image/jpeg') return 'texture.jpg'
  throw new ModelImportError('FBX texture must be PNG or JPEG')
}
