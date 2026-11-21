/**
 * Semantic HTML generator for HTTP 410 Gone responses (RFC 9110 compliant).
 * Returns accessible recovery UI + CTA instead of a bare text/plain response.
 */

export function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildGoneHtml(
  slug: string,
  listingIndexPath: string = "/magang-nasional/lowongan",
): string {
  const safeSlug = escapeHtml(slug);
  const safeListingHref = escapeHtml(
    listingIndexPath.startsWith("/") ? listingIndexPath : "/magang-nasional/lowongan",
  );
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, follow">
  <title>Lowongan Diarsipkan (410 Gone) | MagangHub Kemnaker RI</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem;background:#f8fafc;color:#0f172a;line-height:1.6}
    main{max-width:40rem;margin:3rem auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem}
    .badge{display:inline-block;padding:.25rem .6rem;border-radius:999px;background:#fee2e2;color:#991b1b;font-size:.8rem;font-weight:600}
    h1{margin:.75rem 0 .5rem;font-size:1.5rem}
    .cta{display:inline-block;margin-top:1rem;padding:.65rem 1.1rem;border-radius:8px;background:#0f172a;color:#fff;text-decoration:none;font-weight:600}
    .cta:focus-visible{outline:3px solid #2563eb;outline-offset:3px}
    code{background:#f1f5f9;padding:.15rem .35rem;border-radius:4px;font-size:.875rem}
  </style>
</head>
<body>
  <main>
    <span class="badge">HTTP 410 Gone | Arsip Permanen</span>
    <h1>Lowongan magang ini sudah berakhir</h1>
    <p>Lowongan <code>${safeSlug}</code> berasal dari batch MagangHub sebelumnya dan telah diarsipkan secara permanen.</p>
    <a class="cta" href="${safeListingHref}">Cari Lowongan Magang Aktif</a>
  </main>
</body>
</html>`;
}
