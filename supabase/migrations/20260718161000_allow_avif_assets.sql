update storage.buckets
set allowed_mime_types = array[
  'text/html',
  'application/json',
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/svg+xml'
]
where id = 'siteforge-artifacts';
