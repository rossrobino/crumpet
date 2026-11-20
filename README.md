# crumpet

Build and serve full-stack TypeScript apps on [Bun](https://bun.com). crumpet runs a dev server that reloads the page on save, bundles the server and hashed client assets into a plain `fetch` handler, and writes a Vercel build when it runs on Vercel. It works with any `fetch` handler, such as [ovr](https://github.com/rossrobino/ovr) or [Hono](https://hono.dev), and keeps [domco](https://github.com/rossrobino/domco)'s `fetch` export and build output so apps can switch between the two.

Work in progress: the published package is a placeholder. See [PLAN.md](./PLAN.md) for the design, the decisions so far and the open questions.
