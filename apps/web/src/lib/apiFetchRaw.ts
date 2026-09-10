/**
 * A raw `fetch` against the API that still does everything `apiFetch` does AROUND the body.
 *
 * `apiFetch` is JSON-only: it stringifies the request and parses the response. A handful of calls
 * genuinely cannot use it because the body is not JSON in one direction or the other (a multipart
 * upload, a binary mesh, a ZIP download), and each of those had re-derived the same preamble by
 * hand. They had already drifted: only some sent the workspace-context header, and only some kept
 * the build-id staleness observation. This is that preamble, once.
 *
 * WHAT IT CARRIES, and why each matters:
 *  - `credentials: 'include'`, or the request is unauthenticated.
 *  - `X-PrintStream-Workspace`, or the API resolves the caller's DEFAULT workspace rather than the
 *    one they are looking at. That fails silently and only for users who are not on their default,
 *    which is why it survived review twice.
 *  - `observeServedWebBuildId` on the response, because every API call doubles as a staleness check
 *    (`apiClient.ts`) and a surface with no WebSocket can have one of these as its only recent
 *    request.
 *
 * It deliberately does NOT parse the body or throw on a non-2xx: the callers differ in both (a ZIP
 * download reads a blob, a mesh reads an ArrayBuffer), and inventing one answer here would push them
 * straight back to hand-rolling. {@link readApiErrorMessage} is the shared half of that.
 *
 * Not a replacement for `apiFetch`. A JSON request must still use `apiFetch`.
 */
import { extractErrorMessage, WEB_BUILD_ID_HEADER } from '@printstream/shared'
import { observeServedWebBuildId } from './appStaleness'
import { buildApiUrl } from './apiUrl'
import { readWorkspaceContextHeader } from './workspaceContext'

export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const workspaceContext = readWorkspaceContextHeader()
  const response = await fetch(buildApiUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      ...(workspaceContext ? { 'X-PrintStream-Workspace': workspaceContext } : {}),
      ...(init.headers ?? {})
    }
  })
  observeServedWebBuildId(response.headers.get(WEB_BUILD_ID_HEADER))
  return response
}

/**
 * The message behind a failed {@link apiFetchRaw} response.
 *
 * The API answers errors as a JSON envelope (`{ error, requestId }`), so a caller that throws the
 * raw `response.text()` puts that whole blob in front of the user: `extractErrorMessage` returns an
 * `Error`'s `message` verbatim, so it cannot rescue it afterwards. Parses the envelope where the
 * response says it is JSON and falls back to the body text otherwise.
 */
export async function readApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '')
  return extractErrorMessage(payload, fallback)
}
