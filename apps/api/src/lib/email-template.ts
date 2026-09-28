/**
 * PrintStream's email presentation. Callers own message content and links;
 * this module owns the shared card, brand mark, footer, and safe text fallback.
 * The logo is hosted publicly so SMTP and Cloudflare mail use the same asset.
 */

const BRAND_URL = 'https://printstream.app'
const LOGO_URL = `${BRAND_URL}/icon-512.png`

/** Escape untrusted text before placing it in an HTML email. */
export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Convert a plain-text message to readable HTML without interpreting markup. */
export function emailTextToHtml(text: string): string {
  return text.trim().split(/\n\s*\n/).map((paragraph) =>
    `<p style="margin:0 0 18px;color:#344153;font-size:16px;line-height:1.65;overflow-wrap:anywhere;">${escapeEmailHtml(paragraph).replaceAll('\n', '<br>')}</p>`
  ).join('')
}

/** Email-client-friendly action button; URL must come from a trusted caller. */
export function emailActionButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;"><tr><td bgcolor="#328b9e" style="background:#328b9e;border-radius:7px;"><a href="${escapeEmailHtml(url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:15px;line-height:20px;font-weight:700;text-decoration:none;">${escapeEmailHtml(label)}</a></td></tr></table>`
}

/** Selectable code panel; compact mode keeps long license keys within the card. */
export function emailCodePanel(label: string, code: string, options: { compact?: boolean } = {}): string {
  const codeStyle = options.compact
    ? 'font-size:13px;line-height:1.6;font-family:Arial,Helvetica,sans-serif;letter-spacing:0;word-break:break-all;'
    : 'font-size:28px;line-height:36px;font-weight:700;letter-spacing:3px;'
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;margin:0 0 22px;background:#f3f8f8;border:1px solid #dceced;border-radius:8px;"><tr><td style="padding:17px 19px;"><p style="margin:0 0 6px;color:#59717b;font-size:12px;line-height:18px;font-weight:700;letter-spacing:0.7px;text-transform:uppercase;">${escapeEmailHtml(label)}</p><p style="margin:0;color:#172033;overflow-wrap:anywhere;${codeStyle}">${escapeEmailHtml(code)}</p></td></tr></table>`
}

export interface BrandedEmailContent {
  title: string
  bodyHtml: string
  preheader?: string
  eyebrow?: string
}

/** Wrap trusted, already-escaped body HTML in the approved email layout. */
export function renderBrandedEmail(content: BrandedEmailContent): string {
  const title = escapeEmailHtml(content.title)
  const preheader = escapeEmailHtml(content.preheader ?? content.title)
  const eyebrow = content.eyebrow
    ? `<p style="margin:0 0 12px;color:#288f8b;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;">${escapeEmailHtml(content.eyebrow)}</p>`
    : ''

  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${title}</title></head>`,
    '<body style="margin:0;padding:0;background:#f3f6f8;color:#172033;font-family:Arial,Helvetica,sans-serif;">',
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</div>`,
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;background:#f3f6f8;"><tr><td align="center" style="padding:40px 16px 24px;">',
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="width:100%;max-width:560px;background:#ffffff;border:1px solid #e1e8ed;border-radius:14px;"><tr><td style="padding:34px 38px 38px;">',
    `<img src="${LOGO_URL}" width="112" height="112" alt="PrintStream" style="display:block;width:112px;height:112px;border:0;margin:0 0 12px;">`,
    eyebrow,
    `<h1 style="margin:0 0 18px;color:#172033;font-size:27px;line-height:1.25;font-weight:700;">${title}</h1>`,
    content.bodyHtml,
    '</td></tr></table>',
    `<p style="margin:20px 0 0;color:#748193;font-size:12px;line-height:1.6;">PrintStream <span style="color:#a6b0ba;">&bull;</span> <a href="${BRAND_URL}" style="color:#496b7a;text-decoration:underline;">printstream.app</a></p>`,
    '</td></tr></table></body></html>'
  ].join('')
}
