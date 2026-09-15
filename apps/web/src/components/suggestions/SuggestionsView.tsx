/**
 * Suggestions board routing shell: mounts the list at the board root and the
 * per-post discussion at `:suggestionId`. Mounted in two places, inside a
 * workspace (`/workspaces/:slug/suggestions`, via the plugin route)
 * and in the platform workspace (`/platform/suggestions`), so navigation is
 * derived from wherever the board sits in the current pathname. The board
 * itself is platform-wide: every mount shows the same posts.
 */
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { SuggestionDetailPage } from './SuggestionDetailPage'
import { SuggestionListPage } from './SuggestionListPage'

export function SuggestionsView({ apiBase = '/api/plugins/suggestions' }: { apiBase?: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const boardRootIndex = location.pathname.indexOf('/suggestions')
  const boardRoot = boardRootIndex >= 0
    ? location.pathname.slice(0, boardRootIndex + '/suggestions'.length)
    : '/suggestions'

  return (
    <Routes>
      <Route
        index
        element={<SuggestionListPage apiBase={apiBase} onOpenSuggestion={(id) => navigate(`${boardRoot}/${id}`)} />}
      />
      <Route
        path=":suggestionId"
        element={<SuggestionDetailPage apiBase={apiBase} onBack={() => navigate(boardRoot)} />}
      />
      <Route path="*" element={<Navigate to={boardRoot} replace />} />
    </Routes>
  )
}
