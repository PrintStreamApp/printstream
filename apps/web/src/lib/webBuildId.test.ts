/**
 * Deriving the build id from the emitted bundle.
 *
 * The property that matters is not "produces a hash" but "cannot silently produce a
 * USELESS one". A build id that never changes looks exactly like a healthy one from every
 * angle: the meta tag and `build-id.json` still agree, the server still reports a string,
 * every client agrees with every server, and staleness detection is simply dead. That is
 * how the native update channel shipped inert for two weeks.
 *
 * Importing the plugin here also brings it into the web tsconfig's program, which
 * `include: ["src/**\/*"]` otherwise leaves out entirely.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { computeWebBuildId } from '../../webBuildIdPlugin'

test('refuses to derive an id from nothing', () => {
  // sha256('') is a perfectly valid-looking hash, identical in every build forever. The
  // guard has to be the empty INPUT, not a falsy output.
  assert.throws(() => computeWebBuildId([]), /no emitted assets/)
  assert.throws(() => computeWebBuildId(['index.html']), /no emitted assets/)
})

test('is stable for the same bundle regardless of emit order', () => {
  const first = computeWebBuildId(['assets/a-111.js', 'assets/b-222.css'])
  const second = computeWebBuildId(['assets/b-222.css', 'assets/a-111.js'])
  assert.equal(first, second)
})

test('moves when any emitted file name changes', () => {
  // Vite content-hashes these names, so a changed name IS changed content.
  const before = computeWebBuildId(['assets/a-111.js', 'assets/b-222.css'])
  assert.notEqual(before, computeWebBuildId(['assets/a-999.js', 'assets/b-222.css']))
  assert.notEqual(before, computeWebBuildId(['assets/a-111.js', 'assets/b-222.css', 'assets/c-333.js']))
})

test('ignores HTML, which is the file being stamped', () => {
  // `index.html` carries the id itself, so including it would make the id depend on its
  // own output. Excluding it is why an index.html-only change is invisible here and is
  // left to the service worker instead.
  assert.equal(
    computeWebBuildId(['assets/a-111.js']),
    computeWebBuildId(['assets/a-111.js', 'index.html'])
  )
})
