#!/usr/bin/env node

const explicitUrl = process.env.BAMBUSTUDIO_APPIMAGE_URL?.trim()
if (explicitUrl) {
  console.log(explicitUrl)
  process.exit(0)
}

const repository = process.env.BAMBUSTUDIO_GITHUB_REPOSITORY?.trim() || 'bambulab/BambuStudio'
const assetRegex = buildAssetRegex(process.env.BAMBUSTUDIO_APPIMAGE_ASSET_REGEX)
const releaseUrl = `https://api.github.com/repos/${repository}/releases/latest`
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'PrintStream slicer Docker build'
}
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const response = await fetch(releaseUrl, { headers })
if (!response.ok) {
  throw new Error(`Failed to load ${releaseUrl}: ${response.status} ${response.statusText}`)
}

const release = await response.json()
const assets = Array.isArray(release.assets) ? release.assets : []
const appImages = assets.filter((asset) => {
  return typeof asset.name === 'string'
    && typeof asset.browser_download_url === 'string'
    && /\.AppImage$/i.test(asset.name)
})
const candidates = assetRegex ? appImages.filter((asset) => assetRegex.test(asset.name)) : preferAmd64Assets(appImages)
const selected = candidates[0]
if (!selected) {
  const available = appImages.map((asset) => asset.name).join(', ') || 'none'
  throw new Error(`No matching AppImage asset found in ${repository} latest stable release. AppImage assets: ${available}`)
}

console.error(`Using BambuStudio ${release.tag_name ?? 'latest'} asset: ${selected.name}`)
console.log(selected.browser_download_url)

function buildAssetRegex(value) {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    return new RegExp(trimmed, 'i')
  } catch (error) {
    throw new Error(`Invalid BAMBUSTUDIO_APPIMAGE_ASSET_REGEX: ${error.message}`)
  }
}

function preferAmd64Assets(appImages) {
  const amd64 = appImages.filter((asset) => !/arm64|aarch64/i.test(asset.name))
  if (amd64.length > 0) return amd64
  return appImages
}