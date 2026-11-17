import Link from 'next/link';

// Unknown URLs are the one place a visitor can still land on a bare error
// page. Give them something that matches StarX and leads straight back,
// instead of Next's default white "404 | This page could not be found."
export const metadata = { title: 'StarX — page not found' };

export default function NotFound() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#0b0b0d',
        color: '#f2f3f5',
        font: '14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif',
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div>
        <img
          src="/starx-logo.png"
          alt=""
          width={56}
          height={56}
          style={{ borderRadius: 14, margin: '0 auto 18px', display: 'block' }}
        />
        <h1 style={{ margin: '0 0 6px', fontSize: 22, fontWeight: 600 }}>
          That page isn&apos;t in StarX
        </h1>
        <p style={{ margin: '0 0 20px', color: '#9a9ba3' }}>
          The link may be old or mistyped. Everything else is still here.
        </p>
        <Link
          href="/"
          style={{
            display: 'inline-block',
            padding: '10px 20px',
            borderRadius: 999,
            background: '#1c1c22',
            border: '1px solid #2c2c34',
            color: '#f2f3f5',
            textDecoration: 'none',
          }}
        >
          Back to StarX
        </Link>
      </div>
    </main>
  );
}
