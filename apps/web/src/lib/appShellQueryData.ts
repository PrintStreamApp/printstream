import type { AuthBootstrap, PluginCatalogResponse } from '@printstream/shared'

let latestAuthBootstrap: AuthBootstrap | null = null
let latestPluginCatalog: PluginCatalogResponse | null = null

let authBootstrapResolvers: Array<(value: AuthBootstrap) => void> = []
let pluginCatalogResolvers: Array<(value: PluginCatalogResponse) => void> = []

export function publishAuthBootstrapData(value: AuthBootstrap): void {
  latestAuthBootstrap = value
  for (const resolve of authBootstrapResolvers) {
    resolve(value)
  }
  authBootstrapResolvers = []
}

export function publishPluginCatalogData(value: PluginCatalogResponse): void {
  latestPluginCatalog = value
  for (const resolve of pluginCatalogResolvers) {
    resolve(value)
  }
  pluginCatalogResolvers = []
}

export function waitForAuthBootstrapData(): Promise<AuthBootstrap> {
  if (latestAuthBootstrap) {
    return Promise.resolve(latestAuthBootstrap)
  }

  return new Promise((resolve) => {
    authBootstrapResolvers.push(resolve)
  })
}

export function waitForPluginCatalogData(): Promise<PluginCatalogResponse> {
  if (latestPluginCatalog) {
    return Promise.resolve(latestPluginCatalog)
  }

  return new Promise((resolve) => {
    pluginCatalogResolvers.push(resolve)
  })
}