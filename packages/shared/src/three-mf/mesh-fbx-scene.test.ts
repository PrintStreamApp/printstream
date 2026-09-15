import assert from 'node:assert/strict'
import test from 'node:test'

import {
  importedMeshFromFbxScene,
  readFbxUnitScaleFactor,
  referencedFbxTextures,
  type FbxSceneNode,
  type FbxSceneTexture
} from './mesh-fbx-scene.js'

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

function triangle(name = 'Triangle', matrix = IDENTITY): FbxSceneNode {
  return {
    name,
    isMesh: true,
    geometry: {
      attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0], count: 3, itemSize: 3 } },
      index: { array: [0, 1, 2], count: 3 }
    },
    matrixWorld: { elements: matrix }
  }
}

test('FBX scene conversion applies world transforms and converts centimetres to millimetres', () => {
  const translated = [...IDENTITY]
  translated[12] = 2
  const mesh = importedMeshFromFbxScene(triangle('Shifted', translated))
  assert.deepEqual(mesh.positions, [20, 0, 0, 30, 0, 0, 20, 10, 0])
  assert.deepEqual(mesh.bounds, { min: { x: 20, y: 0, z: 0 }, max: { x: 30, y: 10, z: 0 } })
})

test('FBX scene conversion keeps several scene meshes as named parts', () => {
  const mesh = importedMeshFromFbxScene({ children: [triangle('Body'), triangle('Lid')] }, 0.1)
  assert.deepEqual(mesh.parts?.map((part) => part.name), ['Body', 'Lid'])
  assert.equal(mesh.indices.length, 6)
  assert.equal(mesh.bounds.max.x, 1)
})

test('FBX scene conversion reverses mirrored triangle winding', () => {
  const mirrored = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  assert.deepEqual(importedMeshFromFbxScene(triangle('Mirrored', mirrored), 0.1).indices, [0, 2, 1])
})

test('FBX scene conversion refuses skinned meshes instead of baking the wrong pose', () => {
  assert.throws(
    () => importedMeshFromFbxScene({ ...triangle(), isSkinnedMesh: true }),
    /apply the model pose/
  )
})

test('FBX scene conversion samples decoded diffuse textures into filament source colours', () => {
  const texture: FbxSceneTexture = {
    image: { src: 'data:image/png;base64,unused' },
    offset: { x: 0, y: 0 },
    repeat: { x: 1, y: 1 },
    wrapS: 1000,
    wrapT: 1001
  }
  const node = triangle()
  node.geometry!.attributes!.uv = { array: [0, 0, 0, 0, 0, 0], count: 3, itemSize: 2 }
  node.material = { name: 'Paint', color: { r: 1, g: 1, b: 1 }, map: texture }
  const image = { width: 1, height: 1, rgba: Uint8Array.from([255, 0, 0, 0]) }

  const mesh = importedMeshFromFbxScene(node, 0.1, { decodedTextures: new Map([[texture, image]]) })

  assert.equal(mesh.sourceColorMode, 'texture')
  assert.ok(mesh.indices.length / 3 >= 10_000)
  const firstColor = mesh.triangleCornerColors?.slice(0, 4) ?? []
  assert.ok(Math.abs(firstColor[0]! - 1) < 1e-7)
  assert.deepEqual(firstColor.slice(1), [0, 0, 1])
})

test('FBX texture sampling mirrors V to match Three.js image upload orientation', () => {
  const texture: FbxSceneTexture = { image: { src: 'texture.png' } }
  const node = triangle()
  node.geometry!.attributes!.uv = { array: [0, 0, 0, 0, 0, 0], count: 3, itemSize: 2 }
  node.material = { name: 'Paint', color: { r: 1, g: 1, b: 1 }, map: texture }
  const image = {
    width: 1,
    height: 2,
    // Top row red, bottom row blue. FBX V=0 addresses the bottom row.
    rgba: Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255])
  }

  const mesh = importedMeshFromFbxScene(node, 0.1, { decodedTextures: new Map([[texture, image]]) })
  const firstColor = mesh.triangleCornerColors?.slice(0, 4) ?? []
  assert.deepEqual(firstColor.slice(0, 2), [0, 0])
  assert.ok(Math.abs(firstColor[2]! - 1) < 1e-7)
  assert.equal(firstColor[3], 1)
})

test('FBX scene conversion retains explicit flat material colours without colouring defaults', () => {
  const explicit = triangle('Explicit')
  explicit.material = { name: 'Blue', color: { r: 0, g: 0, b: 1 } }
  assert.equal(importedMeshFromFbxScene(explicit, 0.1).sourceColorMode, 'material')

  const fallback = triangle('Fallback')
  fallback.material = { name: '__DEFAULT', color: { r: 0.8, g: 0.8, b: 0.8 } }
  assert.equal(importedMeshFromFbxScene(fallback, 0.1).sourceColorMode, undefined)

  explicit.material = { name: 'Broken', color: { r: Number.NaN, g: 0, b: 0 } }
  assert.throws(() => importedMeshFromFbxScene(explicit, 0.1), /invalid diffuse material colour/)
})

test('FBX texture references are deduplicated and decoded textures require UVs', () => {
  const texture: FbxSceneTexture = { image: { src: 'texture.png' } }
  const textured = triangle()
  textured.material = [
    { name: 'First', map: texture },
    { name: 'Second', map: texture }
  ]
  assert.deepEqual(referencedFbxTextures(textured), [{ texture, source: 'texture.png' }])

  assert.throws(
    () => importedMeshFromFbxScene(textured, 0.1, {
      decodedTextures: new Map([[texture, { width: 1, height: 1, rgba: Uint8Array.from([0, 0, 0, 255]) }]])
    }),
    /missing texture coordinates/
  )
})

test('FBX unit scale is read from ASCII and binary property records', () => {
  const ascii = new TextEncoder().encode('P: "UnitScaleFactor", "double", "Number", "", 0.1')
  assert.equal(readFbxUnitScaleFactor(ascii), 0.1)

  const chunks: number[] = [...new TextEncoder().encode('Kaydara FBX Binary  \0\x1a\0padding')]
  const stringProperty = (value: string) => {
    const encoded = new TextEncoder().encode(value)
    chunks.push(83, encoded.length, 0, 0, 0, ...encoded)
  }
  stringProperty('UnitScaleFactor')
  stringProperty('double')
  stringProperty('Number')
  stringProperty('')
  chunks.push(68)
  const number = new ArrayBuffer(8)
  new DataView(number).setFloat64(0, 2.54, true)
  chunks.push(...new Uint8Array(number))
  assert.equal(readFbxUnitScaleFactor(Uint8Array.from(chunks)), 2.54)
})
