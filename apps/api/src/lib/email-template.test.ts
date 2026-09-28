import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailActionButton, emailCodePanel, renderBrandedEmail } from './email-template.js'

test('the approved email layout includes the public logo, content, and footer', () => {
  const html = renderBrandedEmail({
    title: "You're invited to PrintStream",
    eyebrow: 'Your invitation',
    bodyHtml: [
      emailActionButton('Open invitation', 'https://printstream.app/invite/example'),
      emailCodePanel('One-time sign-in code', '123456')
    ].join('')
  })

  assert.match(html, /background:#f3f6f8/)
  assert.match(html, /max-width:560px/)
  assert.match(html, /src="https:\/\/printstream\.app\/icon-512\.png"/)
  assert.match(html, /Open invitation/)
  assert.match(html, /123456/)
  assert.match(html, /href="https:\/\/printstream\.app"/)
})

test('long license keys use compact wrapping and escape their content', () => {
  const html = emailCodePanel('License key', '<token>&', { compact: true })
  assert.match(html, /word-break:break-all/)
  assert.match(html, /&lt;token&gt;&amp;/)
  assert.doesNotMatch(html, /<token>/)
})
