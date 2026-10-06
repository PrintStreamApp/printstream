import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emailActionButton, emailCodePanel, emailParagraph, emailTextToHtml, renderBrandedEmail } from './email-template.js'

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

test('shared email paragraphs escape caller text and preserve requested line breaks', () => {
  const body = emailParagraph('<name> & copy\nnext', { lineBreaks: 'preserve' })
  const detail = emailParagraph('Expires <soon>', { kind: 'detail', marginBottom: 22 })
  const disclaimer = emailParagraph('Ignore & delete', { kind: 'disclaimer' })
  const plainText = emailTextToHtml('First <line>\nsecond line\n\nThird & final')

  assert.match(body, /white-space:pre-wrap/)
  assert.match(body, /&lt;name&gt; &amp; copy\nnext/)
  assert.match(detail, /margin:0 0 22px;.*Expires &lt;soon&gt;/)
  assert.match(disclaimer, /border-top:1px solid #edf1f4;.*Ignore &amp; delete/)
  assert.match(plainText, /First &lt;line&gt;<br>second line/)
  assert.match(plainText, /Third &amp; final/)
  assert.doesNotMatch(plainText, /<line>/)
})
