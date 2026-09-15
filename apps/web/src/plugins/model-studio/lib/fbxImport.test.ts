/** Regression coverage for FBX parsing in the editor's normal DOM-free staging worker. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFbxMesh } from './fbxImport.js'

const ASCII_TRIANGLE = `; FBX 7.3.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7300
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UnitScaleFactor", "double", "Number", "",0.1
	}
}
Objects:  {
	Geometry: 1, "Geometry::Triangle", "Mesh" {
		GeometryVersion: 124
		Vertices: *9 {
			a: 0,0,0,1,0,0,0,1,0
		}
		PolygonVertexIndex: *3 {
			a: 0,1,-3
		}
	}
	Model: 2, "Model::Triangle", "Mesh" {
		Version: 232
		Properties70:  {
			P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
			P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
			P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
		}
		Shading: T
		Culling: "CullingOff"
	}
}
Connections:  {
	C: "OO",1,2
	C: "OO",2,0
}
`

test('browser FBX loader parses in the DOM-free worker environment', async () => {
  assert.equal(typeof globalThis.document, 'undefined')
  const createObjectUrl = globalThis.URL.createObjectURL
  const mesh = await parseFbxMesh(new TextEncoder().encode(ASCII_TRIANGLE))
  assert.equal(mesh.indices.length, 3)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
  assert.equal(typeof globalThis.document, 'undefined', 'the temporary image shim is removed')
  assert.equal(globalThis.URL.createObjectURL, createObjectUrl, 'the object URL function is restored')
})

test('browser FBX loader restores an existing page document exactly', async () => {
  const globals = globalThis as unknown as { document?: Document }
  const originalDocument = globals.document
  const createElementNS = (() => ({})) as unknown as typeof document.createElementNS
  globals.document = { createElementNS } as Document
  try {
    await parseFbxMesh(new TextEncoder().encode(ASCII_TRIANGLE))
    assert.equal(globals.document.createElementNS, createElementNS)
  } finally {
    if (originalDocument) globals.document = originalDocument
    else delete globals.document
  }
})
