import assert from 'node:assert/strict'
import test from 'node:test'
import { PNG } from 'pngjs'

import { parseFbxMesh } from './fbx-import.js'

const ASCII_TRIANGLE = `; FBX 7.3.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7300
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",-1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
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

const ASCII_TEXTURED_TRIANGLE = ASCII_TRIANGLE
  .replace(`\t}\n\tModel: 2`, `\t\tLayerElementUV: 0 {
\t\t\tVersion: 101
\t\t\tName: "UVChannel_1"
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tUV: *6 {
\t\t\t\ta: 0,0,1,0,0,1
\t\t\t}
\t\t\tUVIndex: *3 {
\t\t\t\ta: 0,1,2
\t\t\t}
\t\t}
\t\tLayerElementMaterial: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: *1 {
\t\t\t\ta: 0
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementUV"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t}
\t}
\tMaterial: 3, "Material::Paint", "" {
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tMultiLayer: 0
\t\tProperties70:  {
\t\t\tP: "DiffuseColor", "Color", "", "A",1,1,1
\t\t}
\t}
\tTexture: 4, "Texture::Colour", "" {
\t\tType: "TextureVideoClip"
\t\tVersion: 202
\t\tMedia: "Video::colour.png"
\t\tFileName: "colour.png"
\t\tRelativeFilename: "colour.png"
\t}
\tVideo: 5, "Video::colour.png", "Clip" {
\t\tType: "Clip"
\t\tFilename: "colour.png"
\t\tRelativeFilename: "colour.png"
\t}
\tModel: 2`)
  .replace('C: "OO",1,2', `C: "OO",1,2
\tC: "OO",3,2
\tC: "OP",4,3,"DiffuseColor"
\tC: "OO",5,4`)

test('server FBX loader imports ASCII geometry in millimetres', async () => {
  const mesh = await parseFbxMesh(new TextEncoder().encode(ASCII_TRIANGLE))
  assert.equal(mesh.indices.length, 3)
  assert.deepEqual(mesh.bounds, { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } })
})

test('server FBX loader classifies malformed files as data errors', async () => {
  await assert.rejects(() => parseFbxMesh(new TextEncoder().encode('not an FBX')), /FBX could not be imported/)
})

test('server FBX loader refuses external diffuse textures but preview mode stays geometry-only', async () => {
  const bytes = new TextEncoder().encode(ASCII_TEXTURED_TRIANGLE)
  await assert.rejects(() => parseFbxMesh(bytes), /separate texture file/)
  assert.equal((await parseFbxMesh(bytes, { sourceAppearance: false })).indices.length, 3)
})

test('server FBX loader converts an embedded diffuse texture to source paint', async () => {
  const source = new PNG({ width: 1, height: 1 })
  source.data = Buffer.from([255, 0, 0, 0])
  const content = PNG.sync.write(source).toString('base64')
  const embedded = ASCII_TEXTURED_TRIANGLE.replace(
    '\tVideo: 5, "Video::colour.png", "Clip" {\n\t\tType: "Clip"\n\t\tFilename: "colour.png"\n\t\tRelativeFilename: "colour.png"\n\t}',
    `\tVideo: 5, "Video::colour.png", "Clip" {\n\t\tType: "Clip"\n\t\tFilename: "colour.png"\n\t\tRelativeFilename: "colour.png"\n\t\tContent: "${content}"\n\t}`
  )

  const mesh = await parseFbxMesh(new TextEncoder().encode(embedded))

  assert.equal(mesh.sourceColorMode, 'texture')
  assert.ok(mesh.indices.length / 3 >= 10_000)
  assert.equal(mesh.triangleCornerColors?.[3], 1)
})
