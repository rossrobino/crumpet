# crumpet

Build and serve full-stack TypeScript apps on [Bun](https://bun.com). crumpet runs a dev server that reloads the page on save, bundles the server and hashed client assets into a plain `fetch` handler, and (planned) writes a Vercel build with a separate `vercel()` step. The app's default export is plain `Bun.serve` options, so it works with anything that has a `fetch` handler, such as [ovr](https://github.com/rossrobino/ovr) or [Hono](https://hono.dev). The build output has the same shape as [domco](https://github.com/rossrobino/domco)'s, so apps can switch between the two.

Work in progress: the published package is a placeholder. See [PLAN.md](./PLAN.md) for the design, the decisions so far and the open questions.
