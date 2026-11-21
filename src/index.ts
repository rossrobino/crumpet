// Prototype: how much code crumpet needs on top of Bun. Not the final API.
import type { BuildConfig, BuildOutput, BunPlugin, Server } from "bun";
// a plugin's `onResolve` can't wait for a promise, so `shared()` reads files with these
import { existsSync, readFileSync } from "node:fs";
// Bun has no file watcher, recursive delete or rename of its own, and `path` is plain string work
import fs from "node:fs/promises";
import path from "node:path";
// Bun implements Node's styleText, which leaves colors out when the output
// isn't a terminal or NO_COLOR is set, and adds them with FORCE_COLOR
import { styleText } from "node:util";

import { type VercelOptions, vercel as output } from "./vercel.js";

export { onVercel, type VercelOptions } from "./vercel.js";

/**
 * The default export of the app's module: `Bun.serve` options, exactly what
 * Bun serves by itself. crumpet adds its routes and sets `development`.
 */
type App = Bun.Serve.Options<any>;

/** The app's own Bun routes. A framework instance can have an unrelated `routes` array. */
const appRoutes = (app: App) => (Array.isArray(app.routes) ? {} : app.routes);

/** Tags for one client entry point, by kind. */
type Entry = { scripts: string[]; styles: string[]; preloads: string[] };
type Manifest = Record<string, Entry>;

/** What `build()` writes to `dist/server/manifest.json`. */
type Built = {
	/** Tags for each client entry point. */
	entries: Manifest;
	/** Every file in `dist/client/`, relative to it. */
	files: string[];
};

/** Defined when `build()` bundles the server. */
declare const __CRUMPET_BUNDLED__: true;
const bundled = typeof __CRUMPET_BUNDLED__ !== "undefined";

// Read when the bundle starts, next to it: the manifest is written after the
// bundle. Top-level await: modules that import crumpet run after it, so
// `client.head()` works even at their top level.
const built: Built | undefined = bundled
	? await Bun.file(new URL("./manifest.json", import.meta.url)).json()
	: undefined;

let manifest: Manifest = built?.entries ?? {};

/** `client.head()` results, by entry list. Cleared when the manifest changes. */
const heads = new Map<string, string>();

/** Set by the dev server: the script that reloads pages, added by `client.head()`. */
let devScript = "";

const reloadPath = "/_crumpet/reload";
const filePath = "/_crumpet/file/";

/** Files `client.url()` has returned in dev: the only ones the dev server sends. */
const served = new Set<string>();

export const client = {
	/**
	 * @param entries client entry points as passed to `build()`, all of them by default
	 * @returns the stylesheet, modulepreload and module script tags they need
	 */
	head(...entries: string[]) {
		const key = entries.join("\n");
		let html = heads.get(key);
		if (html !== undefined) return html;

		const seen = new Set<string>();
		const tag = (url: string, markup: string) => {
			if (!seen.has(url)) html += markup;
			seen.add(url);
		};
		html = "";
		for (const name of entries.length ? entries : Object.keys(manifest)) {
			// the manifest's names are normalized: `./src/main.ts` is `src/main.ts`
			const entry = manifest[path.normalize(name)];
			if (!entry) throw new Error(`crumpet: "${name}" is not a client entry point.`);
			for (const url of entry.styles) tag(url, `<link rel="stylesheet" href="${url}">`);
			for (const url of entry.preloads) tag(url, `<link rel="modulepreload" href="${url}">`);
			for (const url of entry.scripts) tag(url, `<script type="module" src="${url}"></script>`);
		}
		html += devScript;
		heads.set(key, html);
		return html;
	},

	/**
	 * @param file a file import, such as `import font from "./font.woff2"`
	 * @returns its URL: hashed in the build, served by the dev server in dev
	 */
	url(file: string) {
		if (bundled || !path.isAbsolute(file)) return file;
		served.add(file);
		return filePath + path.relative(process.cwd(), file);
	},
};

/** The app's client options with crumpet's own on top. */
const clientConfig = (client: BuildConfig): BuildConfig => ({
	...client,
	naming: {
		entry: "_immutable/[name]-[hash].[ext]",
		chunk: "_immutable/[name]-[hash].[ext]",
		asset: "_immutable/[name]-[hash].[ext]",
	},
	publicPath: "/",
	splitting: true,
	metafile: true,
});

/** `./_immutable/a.js` or `_immutable/a.js` to `/_immutable/a.js` */
const url = (file: string) => "/" + file.replace(/^\.?\//, "");

/** Reads which output files each entry point needs from Bun's metafile. */
const toManifest = (result: BuildOutput): Manifest => {
	const outputs = new Map(
		Object.entries(
			result.metafile!.outputs as Record<
				string,
				{
					entryPoint?: string;
					cssBundle?: string;
					imports?: { path: string; kind: string }[];
				}
			>,
		).map(([file, out]) => [url(file), out]),
	);

	/** Chunks an output imports statically, all the way down. */
	const chunks = (file: string, found = new Set<string>()) => {
		for (const i of outputs.get(file)?.imports ?? []) {
			const chunk = url(i.path);
			if (i.kind === "import-statement" && outputs.has(chunk) && !found.has(chunk)) {
				found.add(chunk);
				chunks(chunk, found);
			}
		}
		return found;
	};

	const m: Manifest = {};
	for (const [file, out] of outputs) {
		if (!out.entryPoint) continue;
		const css = file.endsWith(".css");
		// the CSS a script imports is an output with the script's entry point:
		// it's that entry's `cssBundle`, not an entry of its own
		if (css && !out.entryPoint.endsWith(".css")) continue;
		m[path.normalize(out.entryPoint)] = css
			? { scripts: [], styles: [file], preloads: [] }
			: {
					scripts: [file],
					styles: out.cssBundle ? [url(out.cssBundle)] : [],
					preloads: [...chunks(file)],
				};
	}
	return m;
};

export type BuildOptions = {
	/**
	 * Named after `Bun.serve`'s option, which it also sets.
	 *
	 * - `true`: serves the app with the client built in memory and reloads
	 *   pages on changes. Run under `bun --watch`, which restarts it when server
	 *   code changes.
	 * - `false`: writes `dist/` and exits.
	 *
	 * @default false
	 */
	development?: boolean;
	/** The app's module, such as `"src/server/app.tsx"`, whose default export is `Bun.serve` options. */
	server: string;
	/**
	 * `Bun.build` options for the client. `entrypoints` are the client entry
	 * points, such as `["src/client/main.ts", "src/client/main.css"]`. crumpet
	 * sets `outdir`, `naming`, `publicPath`, `splitting` and `metafile` itself.
	 */
	client: BuildConfig;
};

/**
 * Serves the app in development, or builds it. Called from the app's
 * `build.ts`:
 *
 * ```ts
 * const development = process.execArgv.includes("--watch");
 * await build({ development, server: "src/server/app.tsx", client: { entrypoints: ["src/client/main.ts"] } });
 * ```
 *
 * @returns the dev server in development, nothing after a build
 */
export const build = async (options: BuildOptions) => {
	development = Boolean(options.development);
	if (development) return dev(options);
	await bundle(options);
};

/** Set by `build()`: in development there's no `dist/` for `vercel()` to use. */
let development = false;

/**
 * Writes `.vercel/output/` from `dist/`, Vercel's Build Output API. Call it
 * after `build()`. It does nothing in development, so it needs no condition:
 *
 * ```ts
 * await build({ development, server, client });
 * await vercel({ isr: { expiration: 60 } });
 * ```
 *
 * - `static/`: `dist/client/`, served by Vercel's CDN
 * - `functions/fn.func/`: `dist/server/` and a `main.js` that exports the app
 *   for Vercel's Bun runtime
 * - `config.json`: the routes
 */
export const vercel = async (options?: VercelOptions) => {
	if (!development) await output(options);
};

/** Serves the app with a client build in memory. */
const dev = async (options: BuildOptions) => {
	const start = performance.now();
	if (!process.execArgv.includes("--watch")) {
		console.warn(
			"crumpet: run the dev server with `bun --watch`, or server changes won't restart it.",
		);
	}
	// Reloads the page when the dev server sends a message, and once it's back
	// after a restart: a closed socket retries every 100 ms, and the next one
	// that opens reloads. Set here so the production bundle leaves it out.
	devScript = `<script type="module">const c=(r)=>{const w=new WebSocket(location.origin.replace("http","ws")+"${reloadPath}");w.onopen=()=>r&&location.reload();w.onmessage=()=>location.reload();w.onclose=()=>setTimeout(c,100,1)};c()</script>`;

	// the app and the first client build, at the same time; the app is imported
	// here so it's in this process's module graph and `bun --watch` restarts on its changes
	// `throw: false`: a build that fails is logged, and the last one stays up
	const config: BuildConfig = { sourcemap: "inline", ...clientConfig(options.client), throw: false };
	const [{ default: app }, first] = await Promise.all([
		import(path.resolve(options.server)) as Promise<{ default: App }>,
		Bun.build(config),
	]);

	/** `ws.data` of the reload sockets, to tell them from the app's own. */
	const reload = {};

	const fixed = {
		[reloadPath]: (req: Request, server: Server<unknown>) =>
			server.upgrade(req, { data: reload }) ? undefined : new Response(null, { status: 400 }),
		// only files `client.url()` has returned, never the rest of the project
		[filePath + "*"]: (req: Request) => {
			const file = path.resolve(
				decodeURIComponent(new URL(req.url).pathname.slice(filePath.length)),
			);
			return served.has(file)
				? new Response(Bun.file(file), { headers: { "cache-control": "no-cache" } })
				: new Response(null, { status: 404 });
		},
	};

	// Client files aren't in the server's module graph, so `bun --watch` doesn't
	// see them. The entry points' folders are watched with their subfolders, and
	// so is the folder of every other file a build read, wherever it is.
	const roots = [...new Set(config.entrypoints.map((e) => path.resolve(path.dirname(e))))];
	const watched = new Set<string>();
	const watch = (dir: string, recursive = false) => {
		if (
			watched.has(dir) ||
			dir.split(path.sep).includes("node_modules") ||
			(!recursive && roots.some((root) => dir.startsWith(root + path.sep)))
		)
			return;
		watched.add(dir);
		(async () => {
			for await (const _ of fs.watch(dir, { recursive })) void changed();
		})().catch(() => watched.delete(dir)); // not a folder: a plugin's virtual file
	};

	/** The client build as routes, served from memory without caching. */
	const clientRoutes = (result: BuildOutput) => {
		manifest = toManifest(result);
		heads.clear();
		for (const input in result.metafile!.inputs) watch(path.resolve(path.dirname(input)));
		return Object.fromEntries(
			result.outputs.map((o) => [
				url(o.path),
				new Response(o, { headers: { "cache-control": "no-cache" } }),
			]),
		);
	};

	// Bun has one `websocket` handler per server: reload sockets are handled
	// here, the app's sockets by the app's handler
	const theirs = app.websocket;
	const websocket: Bun.WebSocketHandler<any> = {
		...theirs,
		open: (ws) => (ws.data === reload ? void ws.subscribe(reloadPath) : theirs?.open?.(ws)),
		message: (ws, message) => (ws.data === reload ? undefined : theirs?.message?.(ws, message)),
		close: (ws, code, reason) => (ws.data === reload ? undefined : theirs?.close?.(ws, code, reason)),
		drain: (ws) => (ws.data === reload ? undefined : theirs?.drain?.(ws)),
	};

	const routes = (client: Record<string, Response>) => ({ ...fixed, ...client, ...appRoutes(app) });

	if (!first.success) console.error(first.logs);
	for (const root of roots) watch(root, true);
	const server = Bun.serve({
		// not the whole network, unless the app says so
		hostname: "localhost",
		...app,
		development: true,
		routes: routes(first.success ? clientRoutes(first) : {}),
		websocket,
	} as App);

	// One save can send several events, and a change can come in during a
	// rebuild: wait briefly, run one rebuild at a time, then one more if
	// anything changed meanwhile, and reload the pages once it's done.
	let building = false;
	let again = false;
	const changed = async () => {
		if (building) {
			again = true;
			return;
		}
		building = true;
		const started = performance.now();
		// a save is often two events (write, then rename); wait for the rest of it
		await Bun.sleep(10);
		let ok = false;
		do {
			again = false;
			const result = await Bun.build(config);
			ok = result.success;
			if (!ok) console.error(result.logs);
			else
				server.reload({
					...app,
					development: true,
					routes: routes(clientRoutes(result)),
					websocket,
				} as App);
		} while (again);
		building = false;
		if (ok) {
			console.log(styleText("dim", `client rebuilt in ${Math.round(performance.now() - started)} ms`));
		}
		server.publish(reloadPath, "reload");
	};

	console.log(
		`\n${styleText(["bold", "green"], "crumpet dev")}  ${styleText("cyan", server.url.href)}  ${styleText("dim", `ready in ${Math.round(performance.now() - start)} ms`)}\n`,
	);
	return server;
};

/**
 * The production server: the default export of the bundle `build()` writes.
 * Bun serves a module's default export when it has `fetch`.
 *
 * @internal used by the generated entry, not by apps
 */
export const production = (app: App) => {
	const dir = Bun.fileURLToPath(new URL("../client/", import.meta.url));
	return {
		...app,
		// Bun.serve runs in development mode unless NODE_ENV is production
		development: false,
		routes: {
			...Object.fromEntries(
				built!.files.map((file) => [
					"/" + file,
					new Response(Bun.file(path.join(dir, file)), {
						headers: file.startsWith("_immutable/")
							? { "cache-control": "public, immutable, max-age=31536000" }
							: {},
					}),
				]),
			),
			...appRoutes(app),
		},
	} as App;
};

/**
 * Keeps a file the server imports as one file when the CSS uses it too. Bun
 * inlines files under 128 KiB into the CSS as `data:` URLs, so a font the page
 * also preloads with `client.url()` would be downloaded twice. Those `url()`s
 * get the URL the server's build gave the file. Bun inlines the rest as usual.
 *
 * @param assets URLs of the files the server imports, by the hash of their content
 */
const shared = (assets: Map<number | bigint, string>): BunPlugin => ({
	name: "crumpet",
	setup(build) {
		build.onResolve({ filter: /^[^:]+$/ }, (args) => {
			// a `url()` in a stylesheet, not its `@import`s
			if (!args.importer.endsWith(".css") || args.kind === "import-rule") return;
			// `font.woff2?v=1#name` is the file `font.woff2`
			const [name, rest = ""] = args.path.split(/(?=[?#])(.*)/s);
			const file = path.resolve(args.resolveDir, name!);
			if (!existsSync(file)) return;
			const url = assets.get(Bun.hash(readFileSync(file)));
			return url ? { path: url + rest, external: true } : undefined;
		});
	},
});

/**
 * Builds `dist/client/` (hashed files under `_immutable/`) and bundles the app
 * into `dist/server/app.js`, whose default export Bun serves by itself:
 * `bun dist/server/app.js`. The server builds first: the client's CSS needs
 * to know which files the server imports. See `shared()`.
 */
const bundle = async (options: BuildOptions) => {
	const start = performance.now();
	await fs.rm("dist", { recursive: true, force: true });

	// only exists in memory, through `Bun.build`'s `files`
	const entry = path.resolve(".crumpet-entry.ts");
	const serverResult = await Bun.build({
		entrypoints: [entry],
		files: {
			[entry]: `import app from ${JSON.stringify(path.resolve(options.server))};
import { onVercel, production } from "crumpet";

export default production(app);
// for the function \`vercel()\` writes
export const vercel = (options) => onVercel(app, options);
`,
		},
		target: "bun",
		// the bundle goes to `dist/server/`, and files it imports, such as
		// fonts, straight to `dist/client/_immutable/` with the client's files
		outdir: "dist/client",
		naming: {
			entry: "../server/app.js",
			asset: "_immutable/[name]-[hash].[ext]",
		},
		publicPath: "/",
		define: { __CRUMPET_BUNDLED__: "true" },
		// folds `bundled` and drops dev-only code; names and lines stay readable
		minify: { syntax: true },
	});

	const client = path.resolve("dist/client");
	const assets = new Map(
		await Promise.all(
			serverResult.outputs
				.filter((o) => o.kind === "asset")
				.map(async (o) => [Bun.hash(await o.arrayBuffer()), url(path.relative(client, o.path))] as const),
		),
	);
	const clientResult = await Bun.build({
		minify: true,
		...clientConfig(options.client),
		plugins: [shared(assets), ...(options.client.plugins ?? [])],
		outdir: "dist/client",
		// a build that fails throws, with Bun's own errors
		throw: true,
	});

	// a CSS entry point also writes an empty JavaScript file
	const empty = clientResult.outputs.filter((o) => o.size === 0);
	const files = [...clientResult.outputs, ...serverResult.outputs]
		.filter((o) => o.size > 0 && o.path.startsWith(client + path.sep))
		.map((o) => path.relative(client, o.path));

	await Promise.all([
		...empty.map((o) => Bun.file(o.path).delete()),
		Bun.write(
			"dist/server/manifest.json",
			JSON.stringify({
				entries: toManifest(clientResult),
				files: [...new Set(files)],
			} satisfies Built),
		),
	]);

	const ms = performance.now() - start;
	await report(
		[...new Set([...clientResult.outputs, ...serverResult.outputs])]
			.filter((o) => o.size > 0)
			.map((o) => path.relative(process.cwd(), o.path)),
		ms,
	);
};

const kB = (bytes: number) => `${(bytes / 1000).toFixed(2)} kB`;

/** Text files, which servers send compressed. Fonts and images already are. */
const compressible = /\.(m?js|css|html|json|svg|txt|xml)$/;

/** Sorts like Vite: other files, then CSS, then JavaScript, the server last; by size within each. */
const order = (file: string) =>
	file.startsWith("dist/server/") ? 3 : file.endsWith(".js") ? 2 : file.endsWith(".css") ? 1 : 0;

/**
 * Prints each output file with its size, and its gzip size if it's text, then
 * the build time:
 *
 * ```txt
 * dist/client/_immutable/main-vz4hds88.css   26.80 kB │ gzip: 20.13 kB
 * dist/server/app.js                        135.06 kB │ gzip: 29.86 kB
 *
 * ✓ built in 24 ms
 * ```
 */
const report = async (files: string[], ms: number) => {
	const rows = (
		await Promise.all(
			files.map(async (file) => {
				const bytes = await Bun.file(file).bytes();
				return {
					file,
					size: kB(bytes.length),
					bytes: bytes.length,
					gzip: compressible.test(file) ? kB(Bun.gzipSync(bytes).length) : "",
				};
			}),
		)
	).sort((a, b) => order(a.file) - order(b.file) || a.bytes - b.bytes);

	const width = (key: "file" | "size" | "gzip") => Math.max(...rows.map((r) => r[key].length));
	const [file, size, gzip] = [width("file"), width("size"), width("gzip")];

	console.log();
	for (const row of rows) {
		const name = path.basename(row.file);
		const color = name.endsWith(".js") ? "cyan" : name.endsWith(".css") ? "magenta" : "green";
		console.log(
			styleText("dim", path.dirname(row.file) + "/") +
				styleText(color, name) +
				" ".repeat(file - row.file.length + 2) +
				styleText("bold", row.size.padStart(size)) +
				(row.gzip ? styleText("dim", ` │ gzip: ${row.gzip.padStart(gzip)}`) : ""),
		);
	}
	console.log(`\n${styleText("green", "✓")} built in ${styleText("bold", `${Math.round(ms)} ms`)}`);
};
