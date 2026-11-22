// Ported from domco's packages/vercel/src/index.test.ts
import { type Route, type VercelOptions, onVercel, vercel } from "./vercel.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir: string;
const cwd = process.cwd();

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "crumpet-vercel-"));
	spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
	process.chdir(cwd);
	await fs.rm(dir, { recursive: true, force: true });
});

const forwarded = { Host: "app.vercel.app", "X-Forwarded-Proto": "https" };

/** An app that answers with the URL it was asked for. */
const urlApp = { fetch: (req: Request) => new Response(req.url) };

/** An app that answers with the client's IP, read the way apps do on Bun. */
const ipApp = {
	fetch: (req: Request, server: Bun.Server<undefined>) =>
		new Response(server.requestIP(req)?.address ?? "none"),
};

/** Calls the app the way Vercel's function would. */
const call = async (
	app: Bun.Serve.Options<any>,
	url: string,
	init?: RequestInit,
	options?: { isr?: boolean },
	server?: object,
) => {
	const wrapped = onVercel(app, options) as {
		fetch(req: Request, server?: object): Promise<Response>;
	};
	return (await wrapped.fetch(new Request(url, init), server)).text();
};

describe("function", () => {
	test("uses X-Forwarded-Proto", async () => {
		expect(await call(urlApp, "http://app.vercel.app/page", { headers: forwarded })).toBe(
			"https://app.vercel.app/page",
		);
	});

	test("keeps the path and query", async () => {
		expect(await call(urlApp, "http://app.vercel.app/weeks?x=1", { headers: forwarded })).toBe(
			"https://app.vercel.app/weeks?x=1",
		);
	});

	test("passes the same request when nothing changes", async () => {
		const seen: Request[] = [];
		const app = onVercel({
			fetch: (req: Request) => {
				seen.push(req);
				return new Response();
			},
		}) as { fetch(req: Request): Promise<Response> };
		const plain = new Request("http://app.vercel.app/");
		const secure = new Request("https://app.vercel.app/", { headers: forwarded });
		await app.fetch(plain);
		await app.fetch(secure);

		expect(seen[0]).toBe(plain);
		expect(seen[1]).toBe(secure);
	});

	test("with ISR, moves __pathname into the pathname and keeps other params", async () => {
		expect(
			await call(
				urlApp,
				"http://app.vercel.app/fn?__pathname=a/b&x=1&y=2",
				{ headers: forwarded },
				{ isr: true },
			),
		).toBe("https://app.vercel.app/a/b?x=1&y=2");
	});

	test("with ISR, decodes the pathname from the query", async () => {
		expect(
			await call(
				urlApp,
				"https://app.vercel.app/fn?__pathname=caf%C3%A9/a%20b",
				undefined,
				{ isr: true },
			),
		).toBe("https://app.vercel.app/caf%C3%A9/a%20b");
	});

	test("with ISR, an empty __pathname is the home page", async () => {
		expect(
			await call(urlApp, "https://app.vercel.app/fn?__pathname=", undefined, { isr: true }),
		).toBe("https://app.vercel.app/");
	});

	test("with ISR, a second __pathname from the client is a 400", async () => {
		const wrapped = onVercel(urlApp, { isr: true }) as { fetch(req: Request): Response };
		const res = wrapped.fetch(new Request("https://app.vercel.app/fn?__pathname=a&__pathname=admin"));
		expect(res.status).toBe(400);
	});

	test("keeps the method, headers and body", async () => {
		const app = {
			fetch: async (req: Request) =>
				new Response(
					[req.url, req.method, req.headers.get("X-Test"), await req.text()].join(" "),
				),
		};
		const init = {
			method: "POST",
			headers: { ...forwarded, "X-Test": "1" },
			body: "hello",
		};

		expect(await call(app, "http://app.vercel.app/", init)).toBe(
			"https://app.vercel.app/ POST 1 hello",
		);
		expect(
			await call(app, "http://app.vercel.app/fn?__pathname=form&a=1", init, { isr: true }),
		).toBe("https://app.vercel.app/form?a=1 POST 1 hello");
	});

	test("calls fetch on the app", async () => {
		class Framework {
			name = "framework";
			fetch() {
				return new Response(this.name);
			}
		}

		expect(await call(new Framework() as never, "https://app.vercel.app/")).toBe("framework");
	});

	test("leaves an app without fetch as it is", () => {
		const app = { routes: { "/": new Response("home") } };

		expect(onVercel(app)).toBe(app);
	});

	test("keeps the app's other options", () => {
		const routes = { "/hi": new Response("hi") };

		expect(onVercel({ ...urlApp, routes })).toMatchObject({ routes });
	});
});

describe("client IP", () => {
	// Vercel overwrites `x-forwarded-for` at its edge, a client can still send `x-real-ip`
	const headers = {
		"X-Forwarded-For": "203.0.113.1",
		"X-Real-IP": "198.51.100.7",
	};

	test("requestIP() returns the IP Vercel sets", async () => {
		expect(await call(ipApp, "https://app.vercel.app/", { headers })).toBe("203.0.113.1");
		expect(
			await call(ipApp, "https://app.vercel.app/fn?__pathname=", { headers }, { isr: true }),
		).toBe("203.0.113.1");
	});

	test("requestIP() returns null without the header", async () => {
		expect(
			await call(ipApp, "https://app.vercel.app/", { headers: { "X-Real-IP": "198.51.100.7" } }),
		).toBe("none");
	});

	test("uses the last valid address", async () => {
		const ip = (value: string) =>
			call(ipApp, "https://a/", { headers: { "X-Forwarded-For": value } });

		expect(await ip("203.0.113.1, 2001:db8::1")).toBe("2001:db8::1");
		expect(await ip("not-an-ip")).toBe("none");
	});

	test("gives the address family", async () => {
		const app = {
			fetch: (req: Request, server: Bun.Server<undefined>) =>
				Response.json(server.requestIP(req)),
		};
		const ip = async (value: string) =>
			JSON.parse(await call(app, "https://a/", { headers: { "X-Forwarded-For": value } }));

		expect(await ip("203.0.113.1")).toStrictEqual({ address: "203.0.113.1", family: "IPv4", port: 0 });
		expect(await ip("2001:db8::1")).toMatchObject({ family: "IPv6" });
	});

	test("replaces requestIP() on a real server and keeps the rest", async () => {
		using server = Bun.serve({ port: 0, fetch: () => new Response() });
		const app = {
			fetch: (req: Request, s: Bun.Server<undefined>) =>
				new Response(`${s.requestIP(req)?.address} ${s.port} ${s.pendingRequests}`),
		};

		expect(await call(app, "https://a/", { headers }, undefined, server)).toBe(
			`203.0.113.1 ${server.port} 0`,
		);
	});
});

describe("build output", () => {
	/**
	 * Runs `vercel()` in a project with a client and server build, the way
	 * `build()` leaves `dist/`, and returns helpers to read what it wrote.
	 */
	const build = async (options?: VercelOptions) => {
		const project = await fs.mkdtemp(path.join(dir, "project-"));
		const files: Record<string, string> = {
			"dist/client/_immutable/app-3f2a9c1d.js": "console.log(1);",
			"dist/server/app.js": "export default {};",
			"dist/server/manifest.json": "{}",
			".vercel/output/stale.txt": "left from the last build",
		};
		for (const [file, content] of Object.entries(files)) {
			await Bun.write(path.join(project, file), content);
		}

		process.chdir(project);
		try {
			await vercel(options);
		} finally {
			process.chdir(cwd);
		}

		const output = path.join(project, ".vercel", "output");
		const read = (file: string) => Bun.file(path.join(output, file)).text();
		const json = (file: string) => Bun.file(path.join(output, file)).json();
		const exists = (file: string) => Bun.file(path.join(output, file)).exists();

		return { read, json, exists };
	};

	/** Applies a redirect route to a pathname like Vercel does, or `null` if it doesn't match. */
	const redirect = (route: Route, pathname: string) => {
		const location = route.headers?.Location;
		if (!location || !route.src) throw new Error("Not a redirect route.");

		const match = new RegExp(route.src).exec(pathname);
		if (!match) return null;
		return location.replace(/\$(\d)/g, (_: string, i: string) => match[Number(i)] ?? "");
	};

	test("needs dist/", async () => {
		const project = await fs.mkdtemp(path.join(dir, "empty-"));
		process.chdir(project);
		try {
			await expect(vercel()).rejects.toThrow("Call `build()` first");
		} finally {
			process.chdir(cwd);
		}
	});

	test("writes version 3 of the Build Output API", async () => {
		const { json } = await build();
		const { version } = await Bun.file(path.join(import.meta.dir, "../package.json")).json();

		expect(await json("config.json")).toMatchObject({
			version: 3,
			framework: { slug: "crumpet", version },
		});
	});

	test("caches immutable files, serves static files, then the function", async () => {
		const { json } = await build();

		expect((await json("config.json")).routes).toStrictEqual([
			{
				src: "/_immutable/.+",
				headers: { "Cache-Control": "public, immutable, max-age=31536000" },
			},
			{ methods: ["GET"], handle: "filesystem" },
			// Vercel passes the client's path and query to a function it rewrites
			// to, with the query of the rewrite added, so only ISR adds `__pathname`
			{ src: "^/(.*)$", dest: "/fn" },
		]);
	});

	test("passes the pathname in __pathname with ISR", async () => {
		const { json } = await build({ isr: { expiration: 60 } });

		expect((await json("config.json")).routes.at(-1)).toStrictEqual({
			src: "^/(.*)$",
			dest: "/fn?__pathname=$1",
		});
	});

	test("adds a slash with trailingSlash: true", async () => {
		const { json } = await build({ trailingSlash: true });
		const [add, remove, ...rest] = (await json("config.json")).routes as Route[];

		expect(add).toMatchObject({ status: 308 });
		expect(redirect(add!, "/about")).toBe("/about/");
		expect(redirect(add!, "/blog/post")).toBe("/blog/post/");
		expect(redirect(add!, "/about/")).toBeNull();
		expect(redirect(add!, "/")).toBeNull();
		// files keep their names
		expect(redirect(add!, "/style.css")).toBeNull();

		expect(remove).toMatchObject({ status: 308 });
		expect(redirect(remove!, "/style.css/")).toBe("/style.css");
		expect(redirect(remove!, "/about/")).toBeNull();

		expect(rest).toHaveLength(3);
	});

	test("removes the slash with trailingSlash: false", async () => {
		const { json } = await build({ trailingSlash: false });
		const [remove, ...rest] = (await json("config.json")).routes as Route[];

		expect(remove).toMatchObject({ status: 308 });
		expect(redirect(remove!, "/about/")).toBe("/about");
		expect(redirect(remove!, "/blog/post/")).toBe("/blog/post");
		expect(redirect(remove!, "/about")).toBeNull();
		expect(redirect(remove!, "/")).toBeNull();

		expect(rest).toHaveLength(3);
	});

	test("never redirects to another site", async () => {
		const routes = [
			...((await (await build({ trailingSlash: true })).json("config.json")).routes as Route[]),
			...((await (await build({ trailingSlash: false })).json("config.json")).routes as Route[]),
		].filter((route) => route.status === 308);
		// `//evil.com` and `/\evil.com` are another site to a browser
		for (const route of routes)
			for (const attack of ["//evil.com/", "/\\evil.com/", "//evil.com", "/\\evil.com", "//evil.com/a.css/"]) {
				const location = redirect(route, attack);
				if (location) expect(new URL(location, "https://app.example").host).toBe("app.example");
			}
	});

	test("adds no redirects without trailingSlash", async () => {
		const { json } = await build();

		expect((await json("config.json")).routes).toHaveLength(3);
	});

	test("writes the images config only when it's set", async () => {
		const images = {
			sizes: [640, 1080],
			domains: [],
			formats: ["image/avif" as const],
		};

		expect((await (await build({ images })).json("config.json")).images).toStrictEqual(images);
		expect((await (await build()).json("config.json")).images).toBeUndefined();
	});

	test("configures a Bun function by default", async () => {
		const { json } = await build();

		expect(await json("functions/fn.func/.vc-config.json")).toStrictEqual({
			handler: "main.js",
			runtime: "bun1.x",
			supportsResponseStreaming: true,
		});
	});

	test("merges the function config", async () => {
		const { json } = await build({
			config: { runtime: "bun2.x", regions: ["cle1"], maxDuration: 30 },
		});

		expect(await json("functions/fn.func/.vc-config.json")).toStrictEqual({
			handler: "main.js",
			runtime: "bun2.x",
			supportsResponseStreaming: true,
			regions: ["cle1"],
			maxDuration: 30,
		});
	});

	test("makes the function an ES module", async () => {
		const { json } = await build();

		expect(await json("functions/fn.func/package.json")).toStrictEqual({ type: "module" });
	});

	test("copies the server into the function and the client into static", async () => {
		const { read } = await build();

		expect(await read("functions/fn.func/app.js")).toBe("export default {};");
		expect(await read("functions/fn.func/manifest.json")).toBe("{}");
		expect(await read("static/_immutable/app-3f2a9c1d.js")).toBe("console.log(1);");
	});

	test("writes an entry that exports the app for Vercel", async () => {
		expect(await (await build()).read("functions/fn.func/main.js")).toBe(
			'import { vercel } from "./app.js";\n\nexport default vercel({"isr":false});\n',
		);
		expect(
			await (await build({ isr: { expiration: 60 } })).read("functions/fn.func/main.js"),
		).toContain('vercel({"isr":true})');
	});

	test("removes the previous output", async () => {
		const { exists } = await build();

		expect(await exists("stale.txt")).toBe(false);
	});

	test("writes no prerender config without ISR", async () => {
		const { exists } = await build();

		expect(await exists("functions/fn.prerender-config.json")).toBe(false);
	});

	test("writes the prerender config with ISR", async () => {
		const { json } = await build({ isr: { expiration: 60 } });

		expect(await json("functions/fn.prerender-config.json")).toStrictEqual({
			expiration: 60,
			group: 1,
			passQuery: true,
			allowQuery: ["__pathname"],
		});
	});

	test("keeps the ISR options and adds __pathname to allowQuery", async () => {
		const isr = {
			expiration: false as const,
			allowQuery: ["page"],
			passQuery: false,
			bypassToken: "a".repeat(32),
		};
		const { json } = await build({ isr });

		expect(await json("functions/fn.prerender-config.json")).toStrictEqual({
			expiration: false,
			group: 1,
			passQuery: false,
			allowQuery: ["page", "__pathname"],
			bypassToken: "a".repeat(32),
		});
	});

	test("leaves the ISR options as they were", async () => {
		const options = { isr: { expiration: 60, allowQuery: ["page"] } };
		await build(options);
		const { json } = await build(options);

		expect(options.isr.allowQuery).toStrictEqual(["page"]);
		expect((await json("functions/fn.prerender-config.json")).allowQuery).toStrictEqual([
			"page",
			"__pathname",
		]);
	});
});
