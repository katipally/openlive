"use client";

// Catches render errors anywhere in the tree so a crash shows a recovery screen
// instead of a blank window. global-error replaces the root layout, so it ships
// its own <html>/<body> — and no stylesheet, so colors are inlined. They follow
// the user's OS theme via a media query (globals.css isn't loaded here) and use
// the brand accent, not an off-palette indigo.
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html>
      <head>
        <style>{`
          :root { --bg: #efede8; --ink: #1a1a18; --muted: #6a6a66; --faint: #8a8a85; }
          @media (prefers-color-scheme: dark) {
            :root { --bg: #0b0b0c; --ink: #e5e5e5; --muted: #a1a1aa; --faint: #71717a; }
          }
        `}</style>
      </head>
      <body style={{ margin: 0, background: "var(--bg)", color: "var(--ink)", fontFamily: "system-ui, sans-serif",
        display: "grid", placeItems: "center", height: "100vh" }}>
        <div style={{ textAlign: "center", maxWidth: 420, padding: 24 }}>
          <h2 style={{ fontWeight: 600, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: "var(--muted)", fontSize: 14, marginBottom: 20 }}>
            OpenLive hit an unexpected error. You can reload without losing your saved settings or chats.
          </p>
          <button onClick={() => reset()} style={{ background: "#2f6fed", color: "#fff", border: 0,
            borderRadius: 10, padding: "10px 18px", fontSize: 14, cursor: "pointer" }}>
            Reload
          </button>
          {error?.message && <pre style={{ marginTop: 20, fontSize: 11, color: "var(--faint)",
            whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{error.message}</pre>}
        </div>
      </body>
    </html>
  );
}
