# crumpet

Build and serve full-stack TypeScript apps on [Bun](https://bun.com).

crumpet is a thin layer over `Bun.build` and `Bun.serve`. It runs a dev server that reloads the page on save, bundles the server and the client with hashed file names, and can write a Vercel build. It's under 800 lines with no dependencies.

It works with anything that has a `fetch` handler: [ovr](https://github.com/rossrobino/ovr) is the main use, and [Hono](https://hono.dev) or a hand-written `fetch` work the same way. crumpet is the Bun version of [domco](https://github.com/rossrobino/domco), which stays the Vite version. The build output has the same shape, so an app can move between the two.

> Early release, tested on Bun 1.4.5. The Vercel output is tested locally but hasn't been deployed yet.

## The idea

- **Bun's APIs, one for one.** The app's default export is `Bun.serve` options. The `client` option is `Bun.build` options. If Bun has a feature, crumpet doesn't wrap it.
- **Nothing based on file names.** No pages folder, no HTML files, no config file and no CLI. Entry points are listed in code, and the app renders the whole page.
- **One `build.ts`.** `bun --watch build.ts` runs the dev server and `bun build.ts` builds. Extra steps go in the same file.
- **A plain output.** `dist/server/app.js` is a module Bun serves by itself: `bun dist/server/app.js`.

## Install

```sh
bun add -d crumpet
```

## Set up

```ts
// build.ts
import { build } from "crumpet";

await build({
	// `bun --watch build.ts` runs the dev server, `bun build.ts` builds
	development: process.execArgv.includes("--watch"),
	server: "src/server/app.ts",
	client: { entrypoints: ["src/client/main.ts", "src/client/main.css"] },
});
```

```json
{
	"scripts": {
		"dev": "bun --watch build.ts",
		"build": "bun build.ts",
		"start": "bun dist/server/app.js"
	}
}
```

The server module's default export is what Bun serves: `fetch`, `routes`, `websocket`, `port` and the rest of `Bun.serve`'s options.

```ts
// src/server/app.ts
import { client } from "crumpet";

export default {
	fetch() {
		return new Response(
			`<!doctype html><html><head>${client.head()}</head><body><h1>Hello</h1></body></html>`,
			{ headers: { "content-type": "text/html" } },
		);
	},
} satisfies Bun.Serve.Options<undefined>;
```

With a framework, pass its `fetch`. ovr takes the client's IP as an option:

```ts
export default {
	fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req)?.address }),
} satisfies Bun.Serve.Options<undefined>;
```

## API

### `build(options)`

- `development`: `true` serves the app with the client built in memory and reloads pages on changes. `false`, the default, writes `dist/`.
- `server`: the app's module.
- `client`: `Bun.build` options for the client, so `plugins` and `define` apply in dev and in the build. crumpet sets `outdir`, `naming`, `publicPath`, `splitting` and `metafile`.

In development the server runs unbundled, `bun --watch` restarts it when server code changes, and crumpet rebuilds the client when client files change. The dev server listens on `localhost` unless the app sets `hostname`.

A build writes:

```txt
dist/
  client/_immutable/   hashed scripts, styles and files
  server/app.js        the app, bundled
  server/manifest.json which files each entry point needs
```

The production server sends everything in `_immutable/` with `Cache-Control: public, immutable, max-age=31536000`.

### `client.head(...entries)`

Returns the stylesheet, modulepreload and module script tags for the client entry points, as an HTML string. With no arguments it covers every entry point; pass some to send a page only what it needs:

```ts
client.head("src/client/main.css", "src/client/dashboard.ts");
```

### `client.url(file)`

Turns a file import into a URL: hashed in the build, a dev route in dev.

```ts
import icon from "./icon.svg";

`<link rel="icon" href="${client.url(icon)}">`;
```

### `vercel(options?)`

Writes `.vercel/output/` from `dist/`, using Vercel's [Build Output API](https://vercel.com/docs/build-output-api/v3). Call it after `build()`; it does nothing in development.

```ts
import { build, vercel } from "crumpet";

await build({ development, server, client });
await vercel({ isr: { expiration: 60 } });
```

Options: `config` (the function's memory, duration and regions), `isr`, `images` and `trailingSlash`.

## Things to know

- **Tailwind** works as a client plugin: `client: { entrypoints, plugins: [tailwind] }` with `bun-plugin-tailwind`.
- **Don't preload a font under 128 KB that the CSS uses.** Bun inlines files that small into the stylesheet, so the font arrives with the CSS and a preload would download it again.
- **Types for file imports are the app's.** Bun declares only a few extensions, so declare the rest, such as `*.svg`, in a `.d.ts` file. See [`example/src/env.d.ts`](./example/src/env.d.ts).
- **Text imports** use `with { type: "text" }`, and path aliases come from tsconfig `paths`. Both are Bun's.

## Example

[`example/`](./example) is an ovr app with Tailwind, a font, a text import and the Vercel step.

## Develop

```sh
bun install
bun test         # runs a small app through build, production and dev
bun run check    # type check
bun run build    # dist/, built with Bun
```

The Tailwind tests use the example's packages, so run `bun install` in `example/` too.
