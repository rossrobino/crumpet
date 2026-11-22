// crumpet: `build()`, `client` and the dev and production servers, on top of Bun.
import type { BuildConfig, BuildOutput, BunPlugin, Server } from "bun";
// a plugin's `onResolve` can't wait for a promise
import { existsSync, readFileSync } from "node:fs";
// Bun has no file watcher or recursive delete of its own, and `path` is plain string work
import fs from "node:fs/promises";
import { isIP } from "node:net";
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

// Read when the bundle starts, next to it, so the client and server builds
// don't wait on each other. Top-level await: modules that import crumpet run
// after it, so `client.head()` works even at their top level.
const built: Built | undefined = bundled
	? await Bun.file(new URL("./manifest.json", import.meta.url)).json()
	: undefined;

let manifest: Manifest = built?.entries ?? {};

/** Set by the dev server: the script that reloads pages, added by `client.head()`. */
let devScript = "";

const reloadPath = "/_crumpet/reload";
const filePath = "/_crumpet/file/";

/** Files `client.url()` has returned in dev: the only ones the dev server sends. */
const served = new Set<string>();

/** The client build's tags and file URLs, for the HTML the server renders. */
export const client = {
	/**
	 * @param entries client entry points as passed to `build()`, all of them by default
	 * @returns their stylesheet tags, then modulepreloads, then module scripts, each
	 * once, and the reload script in dev
	 * @throws if an entry isn't a client entry point
	 */
	head(...entries: string[]) {
		// every entry's stylesheets, then preloads, then scripts, each once
		const tags = { styles: new Set<string>(), preloads: new Set<string>(), scripts: new Set<string>() };
		for (const name of entries.length ? entries : Object.keys(manifest)) {
			// the manifest's names are normalized: `./src/main.ts` is `src/main.ts`
			const entry = manifest[path.normalize(name)];
			if (!entry) throw new Error(`crumpet: "${name}" is not a client entry point.`);
			for (const kind of ["styles", "preloads", "scripts"] as const)
				for (const url of entry[kind]) tags[kind].add(url);
		}
		return (
			[...tags.styles].map((url) => `<link rel="stylesheet" href="${url}">`).join("") +
			[...tags.preloads].map((url) => `<link rel="modulepreload" href="${url}">`).join("") +
			[...tags.scripts].map((url) => `<script type="module" src="${url}"></script>`).join("") +
			devScript
		);
	},

	/**
	 * @param file a file import, such as `import font from "./font.woff2"`
	 * @returns its URL: hashed in the build, served by the dev server in dev
	 */
	url(file: string) {
		if (bundled || !path.isAbsolute(file)) return file;
		served.add(file);
		// the whole path: `../` would be removed from a URL, for a file outside the project
		return filePath + encode(path.relative("/", file));
	},
};

/** Font files, by extension. */
const fontFile = /\.(woff2?|ttf|otf|eot)$/;

/**
 * Keeps fonts as files of their own. Bun inlines files under 128 KiB into the
 * CSS as `data:` URLs: the page couldn't draw until every font had arrived
 * with the stylesheet, and a change to the CSS would download them again. A
 * font a stylesheet uses gets `fontURL(file)` instead, and so does a font the
 * server imports, so both are one URL and a preload of it isn't downloaded twice.
 *
 * @param fontURL the URL of a font, from its absolute path
 */
const fonts = (fontURL: (file: string) => string): BunPlugin => ({
	name: "crumpet-fonts",
	setup(build) {
		// a `url()` in a stylesheet; not a URL with a scheme, a path from the root or an `@import`
		build.onResolve({ filter: /^[^:/][^:]*\.(woff2?|ttf|otf|eot)([?#].*)?$/ }, (args) => {
			if (!args.importer.endsWith(".css") || args.kind === "import-rule") return;
			// `font.woff2?v=1#name` is the file `font.woff2`
			const [name, rest = ""] = args.path.split(/(?=[?#])(.*)/s);
			const file = path.resolve(args.resolveDir, name!);
			// a file that isn't there is left to Bun, which reports it
			if (!existsSync(file)) return;
			return { path: fontURL(file) + rest, external: true };
		});
		// `import font from "./font.woff2"` in the server or a client script
		build.onLoad({ filter: fontFile }, (args) => ({
			contents: `export default ${JSON.stringify(fontURL(args.path))};`,
			loader: "js",
		}));
	},
});

/** The app's client options with crumpet's own on top. */
const clientConfig = (client: BuildConfig, fontURL: (file: string) => string): BuildConfig => ({
	...client,
	plugins: [fonts(fontURL), ...(client.plugins ?? [])],
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
		Object.entries(result.metafile!.outputs).map(([file, out]) => [url(file), out]),
	);

	/** Chunks an output imports statically, all the way down. */
	const chunks = (file: string, found = new Set<string>()) => {
		for (const i of outputs.get(file)!.imports) {
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
	 * - `false`: writes `dist/`. Steps after `build()`, such as `vercel()`, run on
	 *   that build.
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
	/**
	 * A folder whose files are served as they are, at their path in it:
	 * `"public"` serves `public/favicon.svg` at `/favicon.svg`. For files that
	 * need a fixed address. The build copies them into `dist/client/`, and
	 * they aren't cached as immutable. A public file is answered before the
	 * app, its `routes` and `fetch` alike, in dev, in production and on Vercel,
	 * whose CDN serves files before the function.
	 */
	public?: string;
};

/** The files in the public folder, relative to it, dotfiles too. */
const publicFiles = async (dir?: string) => {
	if (!dir) return [];
	if (!(await fs.stat(dir).catch(() => undefined))?.isDirectory())
		throw new Error(`crumpet: the public folder "${dir}" doesn't exist.`);
	const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true }));
	// Bun reads them in a route as a parameter and a wildcard
	const pattern = files.find((file) => /[:*]/.test(file));
	if (pattern) throw new Error(`crumpet: the public file "${pattern}" can't be served: its name has ":" or "*".`);
	return files;
};

/** `a/b c.txt` to `a/b%20c.txt`: as a request's path has it, with `/` on every system. */
const encode = (file: string) =>
	file
		.split(path.sep)
		.map((part) => encodeURI(part).replace(/[#?]/g, encodeURIComponent))
		.join("/");

/** `a/b c.txt` to `/a/b%20c.txt` */
const route = (file: string) => "/" + encode(file);

const noCache = { "cache-control": "no-cache" };

/** Each of `files` at its path in `dir`, as a Bun file route. */
const fileRoutes = (dir: string, files: string[], headers: (file: string) => HeadersInit) =>
	Object.fromEntries(
		files.map((file) => [route(file), new Response(Bun.file(path.join(dir, file)), { headers: headers(file) })]),
	);

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

/**
 * Whether a request names this machine: an IP address, `localhost` or the
 * app's `hostname`. Otherwise a site whose domain points at 127.0.0.1 (DNS
 * rebinding) would be the dev server's origin and could read it. Vite checks
 * the same.
 */
const local = (req: Request, hostname?: string) => {
	let host: string;
	try {
		// lowercased, without the port, the brackets of an IPv6 address or a final dot
		host = new URL(`http://${req.headers.get("host")}`).hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
	} catch {
		return false; // not a host at all
	}
	return (
		Boolean(isIP(host)) || host === "localhost" || host.endsWith(".localhost") || host === hostname?.toLowerCase()
	);
};

type Handler = (this: unknown, req: Request, server: Server<unknown>) => unknown;

/** A route or `fetch` that answers 403 to a request that doesn't name this machine. */
const guard = (handler: Handler, hostname?: string): Handler =>
	// Bun calls a handler with the server as `this`
	function (req, server) {
		return local(req, hostname)
			? handler.call(this, req, server)
			: new Response("crumpet: the dev server only answers localhost, an IP address or the app's hostname.", {
					status: 403,
				});
	};

/** `guard()` on a Bun route: a static response, a file, a handler, or handlers by method. */
const guardRoute = (value: unknown, hostname?: string): unknown =>
	value instanceof Response
		? guard(() => value.clone(), hostname)
		: value instanceof Blob
			? guard(() => new Response(value), hostname)
			: typeof value === "function"
				? guard(value as Handler, hostname)
				: value && Object.getPrototypeOf(value) === Object.prototype
					? Object.fromEntries(Object.entries(value).map(([method, v]) => [method, guardRoute(v, hostname)]))
					: // `false`, or an HTML import, which Bun serves itself
						value;

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
	// a font is served from its own file, like a file `client.url()` returns
	const config: BuildConfig = {
		sourcemap: "inline",
		...clientConfig(options.client, client.url),
		throw: false,
	};
	const [{ default: app }, first] = await Promise.all([
		import(path.resolve(options.server)) as Promise<{ default: App }>,
		Bun.build(config),
	]);

	/** `ws.data` of the reload sockets, to tell them from the app's own. */
	const reload = {};

	const fixed = {
		// only from the dev server's own pages: a WebSocket isn't held to the same origin
		[reloadPath]: (req: Request, server: Server<unknown>) =>
			req.headers.get("origin")?.replace(/^\w+:\/\//, "") !== req.headers.get("host")
				? new Response(null, { status: 403 })
				: server.upgrade(req, { data: reload })
					? undefined
					: new Response(null, { status: 400 }),
		// only files `client.url()` has returned, never the rest of the project
		[filePath + "*"]: (req: Request) => {
			let file: string;
			try {
				file = path.resolve("/", decodeURIComponent(new URL(req.url).pathname.slice(filePath.length)));
			} catch {
				// a malformed `%`, which would show Bun's error page
				return new Response(null, { status: 400 });
			}
			return served.has(file)
				? new Response(Bun.file(file), { headers: noCache })
				: new Response(null, { status: 404 });
		},
	};

	// Client files aren't in the server's module graph, so `bun --watch` doesn't
	// see them. The entry points' folders are watched with their subfolders, and
	// so is the folder of every other file a build read, wherever it is.
	const publicDir = options.public && path.resolve(options.public);
	const roots = [...config.entrypoints.map((e) => path.resolve(path.dirname(e))), ...(publicDir ? [publicDir] : [])];

	/** The public folder's files; Bun reads a file route from disk on each request, so edits show. */
	const publicRoutes = async () => fileRoutes(publicDir!, await publicFiles(publicDir), () => noCache);
	let pub = await publicRoutes();
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
		for (const input in result.metafile!.inputs) watch(path.resolve(path.dirname(input)));
		return Object.fromEntries(
			result.outputs.map((o) => [url(o.path), new Response(o, { headers: noCache })]),
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

	const serve = (client: Record<string, Response>) =>
		({
			...app,
			development: true,
			...(app.fetch && { fetch: guard(app.fetch as Handler, app.hostname) }),
			routes: Object.fromEntries(
				// files first, then the app, as in production and on Vercel
				Object.entries({ ...appRoutes(app), ...pub, ...fixed, ...client }).map(([key, value]) => [
					key,
					guardRoute(value, app.hostname),
				]),
			),
			websocket,
		}) as App;

	if (!first.success) console.error(first.logs);
	for (const root of roots) watch(root, true);
	// not the whole network, unless the app says so
	const server = Bun.serve({ hostname: "localhost", ...serve(first.success ? clientRoutes(first) : {}) } as App);

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
		try {
			do {
				again = false;
				// a file added to or removed from the public folder
				pub = await publicRoutes();
				const result = await Bun.build(config);
				ok = result.success;
				if (!ok) console.error(result.logs);
				else server.reload(serve(clientRoutes(result)));
			} while (again);
		} catch (error) {
			// such as the public folder being removed: the next change tries again
			console.error(error);
		} finally {
			building = false;
		}
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
		// files first, then the app, as on Vercel, whose CDN serves them before the function
		routes: {
			...appRoutes(app),
			...fileRoutes(dir, built!.files, (file): HeadersInit =>
				// a public file is checked again on every use, as Vercel's CDN sends it
				file.startsWith("_immutable/") ? { "cache-control": "public, immutable, max-age=31536000" } : { "cache-control": "public, max-age=0, must-revalidate" },
			),
		},
	} as App;
};

/**
 * Builds `dist/client/` (hashed files under `_immutable/`) and bundles the app
 * into `dist/server/app.js`, whose default export Bun serves by itself:
 * `bun dist/server/app.js`. The client and the server build at the same time.
 */
const bundle = async (options: BuildOptions) => {
	const start = performance.now();
	await fs.rm("dist", { recursive: true, force: true });

	// only exists in memory, through `Bun.build`'s `files`
	const entry = path.resolve(".crumpet-entry.ts");
	const pub = await publicFiles(options.public);

	/** Fonts the builds use, relative to `dist/client/`, by their path. */
	const fontFiles = new Map<string, string>();
	const fontURL = (file: string) => {
		let out = fontFiles.get(file);
		if (!out) {
			const { name, ext } = path.parse(file);
			// from the content, like Bun's hashes: the same font keeps its URL across builds
			const hash = Bun.hash(readFileSync(file)).toString(36).padStart(8, "0").slice(-8);
			out = `_immutable/${name}-${hash}${ext}`;
			fontFiles.set(file, out);
		}
		return "/" + out;
	};

	const [clientResult, serverResult] = await Promise.all([
		Bun.build({
			minify: true,
			...clientConfig(options.client, fontURL),
			outdir: "dist/client",
			// a build that fails throws, with Bun's own errors
			throw: true,
		}),
		Bun.build({
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
			plugins: [fonts(fontURL)],
			// the bundle goes to `dist/server/`, and files it imports, such as
			// images, straight to `dist/client/_immutable/` with the client's files
			outdir: "dist/client",
			naming: {
				entry: "../server/app.js",
				asset: "_immutable/[name]-[hash].[ext]",
			},
			publicPath: "/",
			define: { __CRUMPET_BUNDLED__: "true" },
			// folds `bundled` and drops dev-only code; names and lines stay readable
			minify: { syntax: true },
		}),
		options.public && fs.cp(options.public, "dist/client", { recursive: true }),
	]);
	// a CSS entry point also writes an empty JavaScript file
	const empty = clientResult.outputs.filter((o) => o.size === 0);
	// every file written, relative to the project
	const written = [...clientResult.outputs, ...serverResult.outputs]
		.filter((o) => o.size > 0)
		.map((o) => path.relative(process.cwd(), o.path))
		.concat([...fontFiles.values()].map((out) => path.join("dist/client", out)));
	const files = written
		.filter((file) => file.startsWith("dist/client" + path.sep))
		.map((file) => path.relative("dist/client", file))
		.concat(pub);

	await Promise.all([
		...[...fontFiles].map(([file, out]) => Bun.write(path.join("dist/client", out), Bun.file(file))),
		...empty.map((o) => Bun.file(o.path).delete()),
		Bun.write(
			"dist/server/manifest.json",
			JSON.stringify({
				entries: toManifest(clientResult),
				files: [...new Set(files)],
			} satisfies Built),
		),
	]);

	await report([...new Set(written)], performance.now() - start);
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
