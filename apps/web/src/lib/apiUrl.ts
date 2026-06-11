/**
 * URL builders for the API. Use these instead of inlining base-URL
 * concatenation so the dev proxy and the production absolute URL
 * stay interchangeable.
 */
import { getBrowserEnv } from './browserEnv'
import { readWorkspaceContextHeader } from './workspaceContext'

export function buildApiUrl(path: string): string {
  return buildApiUrlWithContext(path, getBrowserEnv().apiBaseUrl, readWorkspaceContextHeader())
}

export function buildApiUrlWithContext(path: string, apiBaseUrl: string, workspaceContext: string | null): string {
  const base = apiBaseUrl.replace(/\/$/, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (!workspaceContext) return `${base}${suffix}`

  if (base) {
    const url = new URL(`${base}${suffix}`)
    url.searchParams.set('tenant', workspaceContext)
    return url.toString()
  }

  const url = new URL(suffix, 'http://printstream.local')
  url.searchParams.set('tenant', workspaceContext)
  return `${url.pathname}${url.search}${url.hash}`
}

export function buildWebSocketUrl(path = '/ws'): string {
  const workspaceContext = readWorkspaceContextHeader()
  const base = getBrowserEnv().apiBaseUrl
  if (!base) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = new URL(`${protocol}//${window.location.host}${path}`)
    if (workspaceContext) url.searchParams.set('tenant', workspaceContext)
    return url.toString()
  }
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = path
  if (workspaceContext) url.searchParams.set('tenant', workspaceContext)
  return url.toString()
}
