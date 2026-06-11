export function DomainMigrationScreen({ targetUrl }: { targetUrl: string }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
      background: 'linear-gradient(180deg, #070b14 0%, #0d1322 100%)',
      color: '#f3f6ff',
      fontFamily: 'system-ui, sans-serif'
    }}>
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ marginBottom: '0.75rem' }}>PrintStream moved</h1>
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          Redirecting to the new domain. If this page does not move automatically, use
          {' '}
          <a href={targetUrl} style={{ color: '#8ac7ff' }}>the new PrintStream address</a>.
        </p>
        <p style={{ margin: '1rem 0 0', lineHeight: 1.5, opacity: 0.82 }}>
          Installed PWAs stay tied to their original domain. If you launched this from the old app icon,
          remove that install and install PrintStream again from printstream.app.
        </p>
      </div>
    </div>
  )
}