# crumpet

## 0.1.0

### Minor Changes

- 08e5249: The first minor release, now used in production on Vercel.
  
  - `build()` runs the dev server with in-memory client builds and page reloads, or writes `dist/` with hashed files and a manifest.
  - `client.head()` and `client.url()` give the server the client's tags and file URLs.
  - `public` serves a folder's files at fixed paths before the app, in dev, in production and on Vercel.
  - Fonts stay separate hashed files instead of being inlined into CSS.
  - The dev server only answers localhost, IP addresses and the app's hostname, and its reload socket checks the origin.
  - `vercel()` writes Vercel's Build Output API, with ISR, images and trailing-slash options. It builds on Vercel's Bun 1.4.4 and runs on its Bun 1.3.14.
