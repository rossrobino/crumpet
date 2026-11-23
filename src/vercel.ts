// Vercel output with the Build Output API, ported from @domcojs/vercel.
// https://vercel.com/docs/build-output-api/v3
import { version } from "../package.json" with { type: "json" };
// Bun has no recursive copy or delete of its own
import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { styleText } from "node:util";

/** https://vercel.com/docs/build-output-api/v3/primitives#serverless-function-configuration */
type FunctionConfig = {
	/** The file the function starts from. */
	handler: string;
	/** @default "bun1.x" */
	runtime: "bun1.x" | (string & {});
	/** Memory in MB. */
	memory?: number;
	/** Longest run time in seconds. */
	maxDuration?: number;
	/** Environment variables, added to the project's. */
	environment?: Record<string, string>[];
	/** [Regions](https://vercel.com/docs/regions) the function is deployed to. */
	regions?: string[];
	supportsWrapper?: boolean;
	/** @default true */
	supportsResponseStreaming?: boolean;
};

/** https://vercel.com/docs/build-output-api/v3/primitives#prerender-configuration-file */
type PrerenderConfig = {
	/** Seconds before the cached response is made again, `false` for never. */
	expiration: number | false;
	/** Responses in the same group are made again at the same time. */
	group?: number;
	/** Value of the `__prerender_bypass` cookie that skips the cache, for Draft Mode. */
	bypassToken?: string;
	/** Fallback file, relative to the configuration file. */
	fallback?: string;
	/** Query parameters cached separately. An empty list ignores the query, `undefined` caches every value. */
	allowQuery?: string[];
	/** Passes the query string to the function. */
	passQuery?: boolean;
};

/** https://vercel.com/docs/build-output-api/v3/configuration#images */
type ImagesConfig = {
	/** Image widths that can be asked for. */
	sizes: number[];
	/** Other domains whose images can be optimized. */
	domains: string[];
	/** Like `domains`, with patterns. */
	remotePatterns?: {
		protocol?: "http" | "https";
		hostname: string;
		port?: string;
		pathname?: string;
	}[];
	/** Seconds to cache the optimized images. */
	minimumCacheTTL?: number;
	formats?: ("image/avif" | "image/webp")[];
	dangerouslyAllowSVG?: boolean;
	contentSecurityPolicy?: string;
	contentDispositionType?: string;
};

/** https://vercel.com/docs/build-output-api/v3/configuration#routes */
export type Route = {
	src?: string;
	dest?: string;
	headers?: Record<string, string>;
	methods?: string[];
	status?: number;
	handle?: "filesystem";
};

export type VercelOptions = {
	/**
	 * The function's configuration, on top of
	 * `{ handler: "main.js", runtime: "bun1.x", supportsResponseStreaming: true }`.
	 */
	config?: Partial<Omit<FunctionConfig, "handler">>;
	/**
	 * [Incremental Static Regeneration](https://vercel.com/docs/incremental-static-regeneration):
	 * caches the function's responses, for example `{ expiration: 60 }` for a
	 * minute. Don't send ETags from the app with it: a 304 for a stale response
	 * never refreshes the cache.
	 */
	isr?: Omit<PrerenderConfig, "fallback" | "group">;
	/** Turns on image optimization at `/_vercel/image?url=&w=&q=`. */
	images?: ImagesConfig;
	/**
	 * - `true`: paths without a trailing slash redirect to the same path with one
	 * - `false`: paths with a trailing slash redirect to the same path without
	 * - `undefined`: no redirects
	 */
	trailingSlash?: boolean;
};

/** With ISR the client's path comes in this query parameter. See the routes in `vercel()`. */
const pathnameParam = "__pathname";

/**
 * The request the client made. Vercel ends TLS at its edge and forwards plain
 * HTTP with `X-Forwarded-Proto`, which it always sets itself. With ISR it also
 * moves the path into the query.
 */
const request = (req: Request, isr?: boolean) => {
	const url = new URL(req.url);
	const proto = req.headers
		.get("x-forwarded-proto")
		?.split(",", 1)[0]!
		.trim()
		.toLowerCase();
	const forwarded =
		(proto === "https" || proto === "http") && url.protocol !== proto + ":";

	if (!forwarded && !isr) return req;
	if (forwarded) url.protocol = proto!;
	if (isr) {
		url.pathname = "/" + (url.searchParams.get(pathnameParam) ?? "");
		url.searchParams.delete(pathnameParam);
	}
	// the method, headers, body and signal come from `req`
	return new Request(url, req);
};

/**
 * Bun's server with `requestIP()` returning the client's address, so
 * `server.requestIP(req)` in the app is right on Vercel too. Vercel sets
 * `X-Forwarded-For` at its edge and overwrites what the client sent; the last
 * address is used in case anything was added after the client's.
 * https://vercel.com/docs/headers/request-headers#x-forwarded-for
 */
const edge = (req: Request, server?: object) => {
	const address = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
	const family = address ? isIP(address) : 0;
	const requestIP = () =>
		family ? { address, family: family === 6 ? "IPv6" : "IPv4", port: 0 } : null;

	if (!server) return { requestIP };
	return new Proxy(server, {
		get(target, key) {
			if (key === "requestIP") return requestIP;
			const value = Reflect.get(target, key);
			// Bun's methods need the real server as `this`
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};

/**
 * The app as Vercel's function runs it: `fetch` gets the request the client
 * made and a server that knows the client's IP. The app's other options stay
 * as they are.
 *
 * @internal used by the function `vercel()` writes, not by apps
 */
export const onVercel = (
	app: Bun.Serve.Options<any>,
	options: { isr?: boolean } = {},
) => {
	const fetch = app.fetch as
		| ((req: Request, server: unknown) => Response | Promise<Response>)
		| undefined;
	if (!fetch) return app;
	return {
		...app,
		fetch: (req: Request, server?: object) =>
			// with ISR the route adds the one `__pathname`; a second came from the client
			options.isr && new URL(req.url).searchParams.getAll(pathnameParam).length !== 1
				? new Response(null, { status: 400 })
				: // called on `app`, so a framework's `fetch` that uses `this` works
					fetch.call(app, request(req, options.isr), edge(req, server)),
	};
};

/** `vercel()` without the development check. Documented in `index.ts`. */
export const vercel = async (options: VercelOptions = {}) => {
	const out = path.join(".vercel", "output");
	const fn = path.join(out, "functions", "fn.func");
	const { isr } = options;

	if (!(await Bun.file("dist/server/app.js").exists()))
		throw new Error("crumpet: `vercel()` needs `dist/`. Call `build()` first, without `development`.");

	const config: FunctionConfig = {
		handler: "main.js",
		runtime: "bun1.x",
		supportsResponseStreaming: true,
		...options.config,
	};

	// after the files, so a file is never redirected, such as `/.well-known/…` without an extension
	const slash: Route[] =
		options.trailingSlash === true
			? [
					// pages get a slash, files lose it
					{ src: "^/((?:[^/\\\\]+/)*[^/\\\\.]+)$", headers: { Location: "/$1/" }, status: 308 },
					{ src: "^/((?:[^/\\\\]+/)*[^/\\\\]+\\.\\w+)/$", headers: { Location: "/$1" }, status: 308 },
				]
			: options.trailingSlash === false
				? [{ src: "^/((?:[^/\\\\]+/)*[^/\\\\]+)/$", headers: { Location: "/$1" }, status: 308 }]
				: [];
	const routes: Route[] = [
		{
			src: "/_immutable/.+",
			headers: { "Cache-Control": "public, immutable, max-age=31536000" },
		},
		// static files first
		{ methods: ["GET"], handle: "filesystem" },
		...slash,
		// Everything else goes to the function. Vercel passes it the client's
		// path and query. ISR caches by the function's own path and `allowQuery`,
		// so there the client's path has to be in the query, and the function
		// moves it back.
		{ src: "^/(.*)$", dest: isr ? `/fn?${pathnameParam}=$1` : "/fn" },
	];

	const json = (file: string, value: unknown) =>
		Bun.write(path.join(out, file), JSON.stringify(value, null, "\t"));

	await fs.rm(out, { recursive: true, force: true });
	// before the files written into `fn`: Bun 1.4.4's cp, which Vercel builds
	// with, fails with EEXIST when the folder appears while it copies
	await fs.cp("dist/server", fn, { recursive: true });
	await Promise.all([
		fs.cp("dist/client", path.join(out, "static"), { recursive: true }),
		// `vercel` is the bundle's second export: `onVercel` around the app
		Bun.write(
			path.join(fn, "main.js"),
			`import { vercel } from "./app.js";\n\nexport default vercel(${JSON.stringify({ isr: Boolean(isr) })});\n`,
		),
		json("config.json", {
			version: 3,
			framework: { slug: "crumpet", version },
			routes,
			...(options.images && { images: options.images }),
		}),
		json("functions/fn.func/.vc-config.json", config),
		json("functions/fn.func/package.json", { type: "module" }),
		isr &&
			json("functions/fn.prerender-config.json", {
				group: 1,
				passQuery: true,
				...isr,
				// without the path every page would be cached as one
				allowQuery: [...(isr.allowQuery ?? []), pathnameParam],
			} satisfies PrerenderConfig),
	]);

	console.log(
		`${styleText("green", "✓")} wrote ${styleText("bold", out + path.sep)} ${styleText("dim", `for ${config.runtime}`)}`,
	);
};
