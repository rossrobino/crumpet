// Prototype: how much code crumpet needs on top of Bun. Not the final API.
import type { BuildConfig, BuildOutput, Server } from "bun";
// Bun has no file watcher, recursive delete or rename of its own, and `path` is plain string work
import fs from "node:fs/promises";
import path from "node:path";
// Bun implements Node's styleText, which leaves colors out when the output
// isn't a terminal or NO_COLOR is set, and adds them with FORCE_COLOR
import { styleText } from "node:util";

/** Connection information passed to `fetch` as the second argument. */
export type FetchInfo = { ip?: string };

type App = {
	fetch(req: Request, info?: FetchInfo): Response | Promise<Response>;
};

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

/** `client.head()` results, by entry list. Cleared when the manifest changes. */
const heads = new Map<string, string>();

/** Set by the dev server: the script that reloads pages, added by `client.head()`. */
let devScript = "";

const reloadPath = "/_crumpet/reload";
const filePath = "/_crumpet/file/";

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
			const entry = manifest[name];
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
		return filePath + path.relative(process.cwd(), file);
	},
};

const clientConfig = (entrypoints: string[]): BuildConfig => ({
	entrypoints,
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
		m[path.normalize(out.entryPoint)] = file.endsWith(".css")
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
	 * - `"dev"`: serves the app with the client built in memory and reloads
	 *   pages on changes. Run under `bun --watch`, which restarts it when server
	 *   code changes.
	 * - `"build"`: writes `dist/` and exits.
	 *
	 * @default "build"
	 */
	mode?: "dev" | "build";
	/** The app's module, such as `"src/server/app.tsx"`, whose default export has `fetch`. */
	server: string;
	/** Client entry points, such as `["src/client/main.ts", "src/client/main.css"]`. */
	client: string[];
	/** Dev server port. @default Bun.env.PORT, or 5173 */
	port?: number;
};

/**
 * Builds the app, or serves it in dev, depending on `mode`. Called from the
 * app's `build.ts`:
 *
 * ```ts
 * const mode = process.execArgv.includes("--watch") ? "dev" : "build";
 * await build({ mode, server: "src/server/app.tsx", client: ["src/client/main.ts"] });
 * ```
 */
export const build = async (options: BuildOptions) =>
	options.mode === "dev" ? dev(options) : bundle(options);

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
	const [{ default: app }, first] = await Promise.all([
		import(path.resolve(options.server)) as Promise<{ default: App }>,
		Bun.build({ ...clientConfig(options.client), sourcemap: "inline" }),
	]);

	const fixed = {
		[reloadPath]: (req: Request, server: Server<undefined>) =>
			server.upgrade(req) ? undefined : new Response(null, { status: 400 }),
		// Bun's directory route rejects `..` and other paths outside the folder
		[filePath + "*"]: { dir: process.cwd() },
	};

	/** The client build as routes, served from memory without caching. */
	const clientRoutes = (result: BuildOutput) => {
		manifest = toManifest(result);
		heads.clear();
		return Object.fromEntries(
			result.outputs.map((o) => [
				url(o.path),
				new Response(o, { headers: { "cache-control": "no-cache" } }),
			]),
		);
	};

	const websocket = {
		open: (ws: Bun.ServerWebSocket<undefined>) => {
			ws.subscribe("reload");
		},
		message() {},
	};

	if (!first.success) console.error(first.logs);
	const server = Bun.serve({
		port: options.port ?? Bun.env.PORT ?? 5173,
		development: true,
		routes: { ...fixed, ...(first.success ? clientRoutes(first) : {}) },
		websocket,
		fetch: (req, server) =>
			app.fetch(req, { ip: server.requestIP(req)?.address }),
	});

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
			const result = await Bun.build({ ...clientConfig(options.client), sourcemap: "inline" });
			ok = result.success;
			if (!ok) console.error(result.logs);
			else server.reload({ routes: { ...fixed, ...clientRoutes(result) }, websocket });
		} while (again);
		building = false;
		if (ok) {
			console.log(styleText("dim", `client rebuilt in ${Math.round(performance.now() - started)} ms`));
		}
		server.publish("reload", "reload");
	};

	// client files aren't in the server's module graph, so `bun --watch` doesn't see them
	for (const dir of new Set(options.client.map((e) => path.dirname(e)))) {
		(async () => {
			for await (const _ of fs.watch(dir, { recursive: true })) void changed();
		})().catch((error) => console.error(`crumpet: stopped watching ${dir}`, error));
	}

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
	const dir = new URL("../client/", import.meta.url).pathname;
	return {
		// Bun.serve runs in development mode unless NODE_ENV is production
		development: false,
		routes: Object.fromEntries(
			built!.files.map((file) => [
				"/" + file,
				new Response(Bun.file(dir + file), {
					headers: file.startsWith("_immutable/")
						? { "cache-control": "public, immutable, max-age=31536000" }
						: {},
				}),
			]),
		),
		// Bun passes its server; the app gets the client IP as `info.ip`
		fetch: (req: Request, server: Server<undefined>) =>
			app.fetch(req, { ip: server.requestIP(req)?.address }),
	};
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
	const [clientResult, serverResult] = await Promise.all([
		Bun.build({
			...clientConfig(options.client),
			outdir: "dist/client",
			minify: true,
		}),
		Bun.build({
			entrypoints: [entry],
			files: {
				[entry]: `import app from ${JSON.stringify(path.resolve(options.server))};
import { production } from "crumpet";

export default production(app);
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
		}),
	]);
	if (!clientResult.success)
		throw new AggregateError(clientResult.logs, "Client build failed.");
	if (!serverResult.success)
		throw new AggregateError(serverResult.logs, "Server build failed.");

	const client = path.resolve("dist/client");
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
