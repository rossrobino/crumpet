# crumpet: project plan

Status: a working prototype. `src/index.ts` (about 260 lines) and `example/` (an ovr app) run in dev and production on Bun 1.4.5. `crumpet@0.0.2` on npm is a placeholder that holds the name.

## What it is

crumpet builds and serves full-stack TypeScript apps on [Bun](https://bun.com). It runs a dev server that reloads the page on save, bundles the server and the client with hashed file names, and can write a Vercel build.

It works with any framework that exposes a `fetch` handler: [ovr](https://github.com/rossrobino/ovr) is the main use case, and [Hono](https://hono.dev) or a hand-written `fetch` work just as well. Nothing in crumpet depends on JSX, and pages are laid out by the app, not by HTML files.

[domco](https://github.com/rossrobino/domco) keeps going as the Vite version. crumpet is the Bun version: an app on domco should be able to switch with small, mechanical changes, and switch back.

## Decisions so far

- **A separate package,** not domco 6.
- **Easy to switch from domco.** The same `fetch` export, a `dist/client/` and `dist/server/` output, and the same Vercel behavior.
- **Not tied to a framework.** Tags are plain HTML strings.
- **Bun is the runtime,** in dev and in production. crumpet supports the latest Bun release and follows it; no version pinning.
- **Everything is bundled.** The server into one file, the client into hashed chunks.
- **Entry points are listed in code.** `client: ["src/client/main.ts", "src/client/main.css"]`. No `+script` or `+style` file names and no HTML files: the app renders the whole page.
- **One `build()` with a `mode` option.** crumpet exports one function, `build({ mode, server, client })`. `mode: "dev"` serves the app with the client built in memory and reloads; `mode: "build"` (the default) writes `dist/`. The app's `build.ts` sets `mode` from Bun's own flags, `process.execArgv.includes("--watch") ? "dev" : "build"`, so `bun --watch build.ts` runs dev and `bun build.ts` builds, with no custom flags. The same `mode` variable decides any extra steps. In dev, `build()` imports the app itself, so `build.ts` doesn't import it.
- **No production server function.** `build()` bundles the app into `dist/server/app.js`, whose default export has `routes`, `fetch` and `development: false`. Bun serves a module's default export by itself, so production is `bun dist/server/app.js`.
- **No config file and no CLI.** Tailwind, Markdown and anything else go in `build.ts`, behind the same `mode` variable.
- **One import path, `crumpet`:** `build` for `build.ts`, `client` for app code, and types.
- **`bun --watch` for dev,** with a small reload script of crumpet's own.
- **Client and server build at the same time.** The manifest isn't baked into the server bundle: `build()` writes `dist/server/manifest.json` (private, next to the bundle), and crumpet reads it with a top-level await when the bundle starts. So `client.head()` works even at the top level of app modules. No plugin needed.
- **The production server serves the client files.** Bun has no built-in static file serving, so the bundle's default export has Bun `routes` for `dist/client/`.
- **Standard imports instead of Vite query strings.** `?raw` becomes `with { type: "text" }`; `?url` becomes a file import passed to `client.url()`.
- **Path aliases are the app's business,** through tsconfig `paths`, which Bun reads.
- **Vercel is built in,** through the Build Output API. No `public/` folder or other file conventions.
- **No source maps in production,** inline ones in dev.
- **No Cloudflare, no prerendering.** ISR stays available but isn't a focus.

## Example app

`example/` is an ovr app:

```txt
example/
  src/
    server/
      app.tsx       ovr App, default export
      layout.tsx    <html> with client.head() and a preloaded font
      note.md       imported with { type: "text" }
    client/
      main.ts       imports mark.ts
      main.css      @import and an @font-face url()
      fonts/font.woff2
  build.ts          calls build() with mode "dev" under bun --watch, "build" otherwise
  tsconfig.json     jsxImportSource ovr, paths for @/
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

```ts
// build.ts
import { build } from "crumpet";

// `bun --watch build.ts` runs the dev server, `bun build.ts` builds
const mode = process.execArgv.includes("--watch") ? "dev" : "build";

if (mode === "build") {
	// extra build steps go here, for example (with `$` from "bun"):
	// await $`tailwindcss -i src/styles/input.css -o src/client/main.css`;
}

await build({
	mode,
	server: "src/server/app.tsx",
	client: ["src/client/main.ts", "src/client/main.css"],
});
```

```tsx
// src/server/layout.tsx
import { client } from "crumpet";
import { Render, type JSX } from "ovr";
import font from "@/client/fonts/font.woff2";

export const Layout = (props: { title: string; children?: JSX.Element }) => (
	<html lang="en">
		<head>
			<title>{props.title}</title>
			<link rel="preload" href={client.url(font)} as="font" type="font/woff2" crossorigin="anonymous" />
			{Render.raw({ markup: client.head() })}
		</head>
		<body>{props.children}</body>
	</html>
);
```

## What works (tested in a browser and with curl, Bun 1.4.5)

| | Result |
| --- | --- |
| Server edit | `bun --watch` restarts; the page reloads within a second |
| Client CSS edit | Rebuilt and the page reloads (no CSS hot swap) |
| Client script edit | Rebuilt and the page reloads |
| `client.head()` | Stylesheet, modulepreload and module script tags, in dev and production |
| `client.url(font)` | A dev URL in dev, `/_immutable/font-<hash>.woff2` in production |
| Text imports | Work in dev and are inlined in the build |
| `@/` aliases | Resolved by Bun from tsconfig `paths` |
| `info.ip` | Passed to ovr from `server.requestIP()`, in dev and production; not taken from `X-Forwarded-For` |
| `bun dist/server/app.js` | Serves the app and the client files, with `Cache-Control: public, immutable, max-age=31536000` for `_immutable/` |
| `bun check` | No type errors |

## What crumpet's code does

1. **`client.head(...entries)`** returns the tags for the given entry points, or all of them. In dev it adds the reload script.
2. **`client.url(file)`** turns a file import into a URL: hashed in production, a dev route in dev.
3. **`build({ mode: "dev", server, client })`:**
   - Warns when it isn't running under `bun --watch`.
   - Imports the app from `server`, so it's in the process's module graph and `bun --watch` restarts on its changes.
   - Builds the client entry points into memory with `Bun.build`, with inline source maps.
   - Imports the app and runs the first client build at the same time.
   - Serves the app's `fetch` with `Bun.serve`. The client build is served as Bun `routes` from memory, swapped with `server.reload()` after each rebuild. Files imported by server code (`client.url()`) are served by a Bun directory route, which rejects paths outside the project.
   - Watches the client entry points' folders, since they aren't in the server's module graph and `bun --watch` doesn't see them.
   - Reloads open pages through Bun's WebSocket pub/sub: `server.publish("reload")` after a client rebuild. After a server restart, the page's socket closes, retries every 100 ms, and reloads when it reconnects.
   - Caches `client.head()` results until the next rebuild.
   - Prints the URL and startup time, and the time of each client rebuild. A save is often two file events, so it waits 10 ms before rebuilding.
4. **`build({ mode: "build", server, client })`:**
   - Runs two `Bun.build`s at the same time: the client into `dist/client/_immutable/` with hashes, and the app into `dist/server/app.js`.
   - The server build's entry only exists in memory (`Bun.build`'s `files`): `export default production(app)`, crumpet's production server with `development: false`, `routes` for `dist/client/`, and `fetch` passing `info.ip`.
   - The server build's output folder is `dist/client/` with the entry named `../server/app.js`, so files the server imports, such as fonts, land in `dist/client/_immutable/` with no move step.
   - `minify: { syntax: true }` on the server folds constants; names and lines stay readable for stack traces. Dev and build code is tree-shaken out of the bundle.
   - Then, at the same time: deletes the empty files and writes `dist/server/manifest.json` (the entries' tags from the client's metafile, and the list of client files for the routes, so the server doesn't scan the folder).
   - Prints each output file with its size, the gzip size for text files, and the build time, like Vite. `Bun.build()` prints nothing itself (only the `bun build` command does). Colors come from `node:util`'s `styleText`, which Bun implements and which leaves them out when the output isn't a terminal or `NO_COLOR` is set.
5. **Vercel output** (not in the prototype yet): the Build Output API in `.vercel/output/`, ported from `@domcojs/vercel`.

## Things Bun didn't do, found while building it

- **`Bun.serve` passes its `server` as `fetch`'s second argument.** ovr's `App.fetch` takes `{ ip, ...RequestInit }` there, the same on every server, so crumpet wraps the app: `(req, server) => app.fetch(req, { ip: server.requestIP(req)?.address })`. That's also what ovr's docs show for Bun. (ovr 7.0.0-next.84 briefly read `requestIP` from the server itself; next.85 reverted that to keep one way to pass the IP.)
- **No built-in static file serving.** The production server adds `routes` for `dist/client/`.
- **`Bun.serve` runs in development mode by default** unless `NODE_ENV=production`, with Bun's error pages. The bundle's default export sets `development: false`.
- **Client files aren't watched by `bun --watch`.** A file imported from server code with a loader (`with { type: "file" }`) is watched, but not the files it imports: editing `client.ts` restarts the server, editing a module `client.ts` imports doesn't. Dev mode watches the client folders itself.
- **Loaders don't build client entry points from server code.** CSS imported by server code is bundled into one file named after the server entry, with no hash and no URL in the import. `with { type: "file" }` copies a `.ts` file as it is, unbundled. The `file` loader is still the way to get hashed URLs for fonts and images.
- **Reloading after a server restart takes care.** The page keeps a connection open to the dev server; when `bun --watch` restarts, it drops, and reconnecting reloads the page. The first version used `EventSource`, but Bun only sends a stream's headers with its first chunk and browsers wait 3 s to reconnect, so it needed workarounds. It now uses Bun's WebSocket pub/sub, with a 100 ms retry in the page.
- **A CSS entry point also writes an empty `.js` file,** which the build deletes.
- **CSS `url()` files under 128 KB are inlined as data URLs,** and no option turns it off ([oven-sh/bun#26575](https://github.com/oven-sh/bun/issues/26575); a fix, [#28923](https://github.com/oven-sh/bun/pull/28923), was closed without merging). That's fine for icons and small images, and for a font used only from CSS (one less request, no flash of fallback text). It costs when the font is also preloaded with `client.url()` (downloaded twice), when there are several fonts or weights (all of them are downloaded, used or not), or when the CSS changes often (the font is downloaded again with each new stylesheet). Workaround when it matters: declare `@font-face` in the server-rendered `<head>` with `client.url(font)`.
- **Bun's own HTML imports and HMR don't fit:** they need an HTML file per page, which ovr apps don't have. Tested and set aside.
- **File and text imports need type declarations** (`*.woff2`, `*.md`). crumpet ships them, like `domco/env`.

## Vercel

Since August 2026, Vercel's Bun runtime accepts a `Bun.serve()` server as a function entrypoint ([changelog](https://vercel.com/changelog/bun-serve-entrypoint-for-vercel-functions), [docs](https://vercel.com/docs/functions/runtimes/bun)). With the Bun framework preset:

- `vercel.json` sets `"bunVersion": "1.4.x"`. (`"1.x"` still means Bun 1.3.14, the last version before the Rust rewrite.)
- The project has a `bun.lock` and a `server.ts` in the root or in `src/` that calls `Bun.serve()` once at startup.
- Vercel routes every request to that server. `fetch`, `routes`, `error` and `websocket` work; `port` and `hostname` only apply locally; HTML imports in `routes` aren't supported.
- The runtime is still in beta.

crumpet doesn't use the preset's file conventions: no `public/` folder and no file-based routing. Static files go to Vercel's CDN through the Build Output API, which `build()` writes when asked for (for example `build({ client, vercel: {...} })`), ported from `@domcojs/vercel`:

- `static/`: `dist/client/`, served by Vercel's CDN, with immutable cache headers for `/_immutable/` from `config.json`.
- `functions/fn.func/`: one function on the Bun runtime (`runtime: "bun1.x"`), whose entry exports `{ fetch }`, the way domco's Bun entry already works.
- `config.json`: the routes.

What the `Bun.serve()` entrypoint change still tells us: Vercel's Bun runtime runs `Bun.serve`-style handlers (`fetch`, `routes`, `websocket`), so the function can be the same `{ routes, fetch }` object the app serves locally.

Questions only a deploy can answer:

- Which Bun version does `runtime: "bun1.x"` in `.vc-config.json` run? `vercel.json`'s `bunVersion` distinguishes `"1.4.x"` from `"1.x"` (Bun 1.3.14); the Build Output API may need the same.
- Does `server.requestIP(req)` return the client's address on Vercel, or should crumpet read `X-Forwarded-For` there, as `@domcojs/vercel`'s Bun entry does?
- Does streaming work through the Bun runtime?

The behavior to keep is specified by domco's Vercel adapter tests, `packages/vercel/src/index.test.ts` in the domco repo:

- **Routes, in order:** trailing-slash redirects (308, when the option is set), immutable cache headers for `/_immutable/`, the filesystem for `GET`, then everything else to the function.
- **The function route:** a plain rewrite to `/fn`. Only with ISR does it add `?__pathname=$1`, which the entry moves back into the pathname.
- **Function config:** `handler: "main.js"`, `supportsResponseStreaming: true`, user options merged in, and a `package.json` with `"type": "module"`.
- **Images:** the `images` option in `config.json`, and the dev redirect for `/_vercel/image`.
- **Requests:** the protocol from `X-Forwarded-Proto`, and the client IP from the last address in `X-Forwarded-For`.
- **ISR, when set:** a `prerender-config.json` with `expiration`, `group: 1`, `passQuery: true` and `allowQuery` including `__pathname`.

## Switching from domco

| domco / Vite | Projects using it | crumpet |
| --- | --- | --- |
| `fetch(req, info)` default export with `info.ip` | all | Same |
| `dist/client/` and `dist/server/` output | all | Same shape |
| `@domcojs/vercel` options | all deployed | A `vercel` option to `build()` |
| `vite.config.ts` | all | A `build.ts` that calls `build()` with a `mode` |
| `+app`, `+script`, `+style` file names | all | Entry points listed in `build.ts` |
| `client:script`, `client:style` | 10 | `client.head()` |
| `@/` path aliases | 9 (265 imports) | tsconfig `paths` |
| `prerender` | 8 | Dropped; render at request time, or ISR |
| `import.meta.glob` | 7 | `fs.glob` or `Bun.Glob` |
| `@robino/md` plugin | 7 | A step in `build.ts` when `mode` is `"build"`, or `Processor` at runtime |
| Tailwind plugin | 6 | Tailwind CLI in `build.ts`, by `mode` |
| `?raw` | 5 | `with { type: "text" }` |
| `client:page` (`+page.html`) | 3 | Dropped; render the page on the server |
| `import.meta.env` | 2 | `process.env` or `Bun.env` |
| `?url` | 2 | A file import through `client.url()` |
| `vite-imagetools` | 1 | Dropped |

## Risks

1. **Vercel's Bun runtime is still in beta.** This is where everything deploys.
2. **Anthropic sets Bun's direction.** Bun has no foundation or governance. domco staying maintained is the way back.
3. **Following the latest Bun means following its changes.** Bun ships a lot each month; crumpet's tests should run against each new release.
4. **The new Bun tools are young.** `bun check` shipped in October 2026, `bun fmt` in 1.4.4, and `bun lint` isn't released yet.

## Open questions

- How should build steps that also watch in dev (`tailwindcss --watch`) run: started by the app in `build.ts`, or a small crumpet helper?
- Deploy the example with the Build Output API on the Bun runtime and answer the questions under "Vercel".
- Write Vercel output whenever the `vercel` option is set, or only when Vercel's `VERCEL=1` environment variable is set during the build?
- Hot-swap CSS in dev instead of reloading the page?
- Wait for Bun to let CSS assets stay files, or work around it?
