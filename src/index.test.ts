// Runs a small app through `build()` the way an app does: `bun build.ts`,
// `bun dist/server/app.js` and `bun --watch build.ts`, each in its own process.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const crumpet = path.join(import.meta.dir, "index.ts");

/** A marker in the module both entry points import, to find where it was bundled. */
const marker = "shared-module-marker";
// Bun inlines files under 128 KiB into the CSS as `data:` URLs; this one stays a file
const font = new Uint8Array(200_000).map((_, i) => (i * 31) % 251);

const files: Record<string, string | Uint8Array> = {
	"tsconfig.json": JSON.stringify({ compilerOptions: { paths: { crumpet: [crumpet] } } }),
	"build.ts": `import { build, vercel } from "crumpet";

await build({
	development: process.execArgv.includes("--watch") || Bun.env.DEV === "1",
	server: "src/server/app.ts",
	client: { entrypoints: ["src/client/a.ts", "./src/client/b.ts", "src/client/main.css"] },
	public: "public",
});
await vercel();
`,
	"src/server/app.ts": `import { client } from "crumpet";
import font from "../client/font.woff2";
import note from "./note.md" with { type: "text" };

export default {
	routes: { "/own": new Response("own route") },
	fetch(req: Request, server: Bun.Server<undefined>) {
		const url = new URL(req.url);
		if (url.pathname === "/head") {
			try {
				return new Response(client.head(...url.searchParams.getAll("e")));
			} catch (error) {
				return new Response(String(error), { status: 400 });
			}
		}
		if (url.pathname === "/font") return new Response(client.url(font));
		if (url.pathname === "/note") return new Response(note);
		if (url.pathname === "/development") return new Response(String(server.development));
		if (url.pathname === "/ws") return server.upgrade(req) ? undefined : new Response(null, { status: 400 });
		return new Response("not found", { status: 404 });
	},
	websocket: {
		message(ws: Bun.ServerWebSocket<undefined>, message: string) {
			ws.send("echo:" + message);
		},
	},
};
`,
	"src/server/note.md": "# a note\n",
	"public/robots.txt": "User-agent: *\n",
	"public/icons/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg"></svg>`,
	"public/.well-known/client.json": `{"client_id":"https://example.com/.well-known/client.json"}`,
	// the app's route has the same path
	"public/own": "from the public folder",
	"src/client/a.ts": `import { shared } from "../lib/shared.ts";
import "./a.css";

console.log("entry a", shared);
`,
	"src/client/b.ts": `import { shared } from "../lib/shared.ts";

console.log("entry b", shared);
`,
	"src/client/a.css": ".a { color: red; }\n",
	"src/client/main.css": `@font-face { font-family: "f"; src: url("./font.woff2"); }\nbody { margin: 0; }\n`,
	"src/client/font.woff2": font,
	// outside the entry points' folder, so it's only watched because a build read it
	"src/lib/shared.ts": `export const shared = "${marker}";\n`,
};

const temp: string[] = [];
const procs: Bun.Subprocess[] = [];

/** A copy of the app in its own folder. */
const fixture = async (changes: typeof files = {}) => {
	// macOS's temp folder is a symlink; processes see the real path as their cwd
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "crumpet-")));
	temp.push(dir);
	await Promise.all(
		Object.entries({ ...files, ...changes }).map(([file, text]) => Bun.write(path.join(dir, file), text)),
	);
	return dir;
};

const freePort = () => {
	const server = Bun.serve({ port: 0, fetch: () => new Response() });
	const { port } = server;
	server.stop(true);
	return port!;
};

const spawn = (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
	const proc = Bun.spawn(cmd, {
		cwd,
		env: { ...Bun.env, NO_COLOR: "1", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	procs.push(proc);
	return proc;
};

/** Runs a command to the end. */
const run = async (cmd: string[], cwd: string) => {
	const proc = spawn(cmd, cwd);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
};

/** Tries until `fn` returns something truthy. */
const until = async <T>(fn: () => T | Promise<T>, ms = 8000) => {
	const end = Date.now() + ms;
	let error: unknown;
	while (Date.now() < end) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (e) {
			error = e;
		}
		await Bun.sleep(25);
	}
	throw new Error("timed out", { cause: error });
};

/** Starts a server and waits until it answers. */
const serve = async (cmd: string[], cwd: string, env: Record<string, string> = {}) => {
	const port = freePort();
	const origin = `http://localhost:${port}`;
	const proc = spawn(cmd, cwd, { PORT: String(port), ...env });
	await until(async () => (await fetch(origin + "/own")).ok);
	const get = (pathname: string) => fetch(origin + pathname);
	return { proc, origin, get, text: async (pathname: string) => (await get(pathname)).text() };
};

const publicFiles = [".well-known/client.json", "icons/favicon.svg", "own", "robots.txt"];
const hashed = (files: string[]) => files.filter((file) => !publicFiles.includes(file));

/** A WebSocket and the messages it has received. */
const socket = async (url: string) => {
	const messages: string[] = [];
	const ws = new WebSocket(url.replace("http", "ws"));
	ws.onmessage = (e) => messages.push(String(e.data));
	await new Promise((resolve, reject) => {
		ws.onopen = resolve;
		ws.onerror = reject;
	});
	return { ws, messages };
};

const walk = async (dir: string) =>
	(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dir, dot: true }))).sort();

const attrs = (html: string, tag: RegExp) => [...html.matchAll(tag)].map((m) => m[1]!);
const scripts = (html: string) => attrs(html, /<script type="module" src="([^"]+)"><\/script>/g);
const styles = (html: string) => attrs(html, /<link rel="stylesheet" href="([^"]+)">/g);
const preloads = (html: string) => attrs(html, /<link rel="modulepreload" href="([^"]+)">/g);

afterAll(async () => {
	for (const proc of procs) proc.kill();
	await Promise.all(procs.map((proc) => proc.exited));
	await Promise.all(temp.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Entry = { scripts: string[]; styles: string[]; preloads: string[] };
type Built = { entries: Record<string, Entry>; files: string[] };

describe("build", () => {
	let dir: string;
	let result: Awaited<ReturnType<typeof run>>;
	let built: Built;
	const dist = (...parts: string[]) => path.join(dir, "dist", ...parts);

	beforeAll(async () => {
		dir = await fixture();
		await Bun.write(dist("stale.txt"), "from an earlier build");
		result = await run(["bun", "build.ts"], dir);
		built = await Bun.file(dist("server/manifest.json")).json();
	});

	test("exits without errors", () => {
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
	});

	test("removes the earlier build", async () => {
		expect(await Bun.file(dist("stale.txt")).exists()).toBe(false);
	});

	test("writes the server bundle and hashed client files", async () => {
		const all = await walk(dist());
		expect(all).toContain("server/app.js");
		expect(all).toContain("server/manifest.json");
		const client = hashed(all.filter((file) => file.startsWith("client/")).map((f) => f.slice(7))).map((f) => "client/" + f);
		expect(client.length).toBeGreaterThan(0);
		for (const file of client) expect(file).toMatch(/^client\/_immutable\/[\w.-]+-[a-z0-9]{8}\.\w+$/);
	});

	test("lists every client file in the manifest", async () => {
		expect([...built.files].sort()).toEqual(await walk(dist("client")));
		expect(new Set(built.files).size).toBe(built.files.length);
	});

	test("names entry points without `./`", () => {
		expect(Object.keys(built.entries).sort()).toEqual([
			"src/client/a.ts",
			"src/client/b.ts",
			"src/client/main.css",
		]);
	});

	test("a script entry has its script, the CSS it imports and its chunks", () => {
		const a = built.entries["src/client/a.ts"]!;
		expect(a.scripts).toEqual([expect.stringMatching(/^\/_immutable\/a-\w+\.js$/)]);
		expect(a.styles).toEqual([expect.stringMatching(/^\/_immutable\/a-\w+\.css$/)]);
		expect(a.preloads).toHaveLength(1);
	});

	test("a script entry without CSS has no styles", () => {
		expect(built.entries["src/client/b.ts"]!.styles).toEqual([]);
	});

	test("a CSS entry has only its stylesheet", () => {
		expect(built.entries["src/client/main.css"]).toEqual({
			scripts: [],
			styles: [expect.stringMatching(/^\/_immutable\/main-\w+\.css$/)],
			preloads: [],
		});
	});

	test("a CSS entry leaves no empty JavaScript file", async () => {
		for (const file of built.files) expect(Bun.file(dist("client", file)).size).toBeGreaterThan(0);
		expect(built.files.filter((file) => /main-\w+\.js$/.test(file))).toEqual([]);
	});

	test("code shared by two entries is in one chunk both preload", async () => {
		const { a, b } = { a: built.entries["src/client/a.ts"]!, b: built.entries["src/client/b.ts"]! };
		expect(a.preloads).toEqual(b.preloads);
		const read = (url: string) => Bun.file(dist("client", url)).text();
		expect(await read(a.preloads[0]!)).toContain(marker);
		expect(await read(a.scripts[0]!)).not.toContain(marker);
		expect(await read(b.scripts[0]!)).not.toContain(marker);
	});

	test("minifies the client", async () => {
		const js = await Bun.file(dist("client", built.entries["src/client/a.ts"]!.scripts[0]!)).text();
		expect(js).not.toContain("sourceMappingURL");
		expect(js.trim().split("\n")).toHaveLength(1);
	});

	test("a file used by the server and the CSS is written once", async () => {
		const fonts = built.files.filter((file) => file.endsWith(".woff2"));
		expect(fonts).toHaveLength(1);
		expect(await Bun.file(dist("client", fonts[0]!)).bytes()).toEqual(font);
		const css = await Bun.file(dist("client", built.entries["src/client/main.css"]!.styles[0]!)).text();
		expect(css).toContain("/" + fonts[0]);
	});

	test("copies the public folder into the client, dotfiles too", async () => {
		for (const file of publicFiles) {
			expect(await Bun.file(dist("client", file)).text()).toBe(files["public/" + file] as string);
			expect(built.files).toContain(file);
		}
	});

	test("prints each file and the build time", () => {
		for (const file of hashed(built.files)) expect(result.stdout).toContain(path.basename(file));
		expect(result.stdout).toContain("dist/server/app.js");
		expect(result.stdout).toMatch(/gzip: +[\d.]+ kB/);
		expect(result.stdout).toMatch(/✓ built in \d+ ms/);
	});

	test("the bundle exports the app for production and for Vercel", async () => {
		const mod = await import(dist("server/app.js"));
		expect(mod.default.development).toBe(false);
		expect(mod.default.fetch).toBeFunction();
		expect(mod.default.websocket.message).toBeFunction();
		expect(mod.vercel).toBeFunction();
		expect(mod.vercel({}).fetch).toBeFunction();
	});

	test("`vercel()` after it writes Vercel's output", async () => {
		expect(result.stdout).toContain(".vercel/output/");
		const out = path.join(dir, ".vercel/output");
		expect(await Bun.file(path.join(out, "functions/fn.func/app.js")).exists()).toBe(true);
		expect((await walk(path.join(out, "static"))).sort()).toEqual([...built.files].sort());
	});

	test("fails when the client doesn't build", async () => {
		const broken = await fixture();
		await Bun.write(path.join(broken, "src/client/b.ts"), "const = ;");
		const { code, stderr } = await run(["bun", "build.ts"], broken);
		expect(code).not.toBe(0);
		expect(stderr).toContain("src/client/b.ts:1:7");
		expect(await fs.exists(path.join(broken, "dist/server/manifest.json"))).toBe(false);
	});

	test("fails when the server doesn't build", async () => {
		const broken = await fixture();
		await Bun.write(path.join(broken, "src/server/app.ts"), `import "./missing.ts";`);
		const { code, stderr } = await run(["bun", "build.ts"], broken);
		expect(code).not.toBe(0);
		expect(stderr).toContain(`Could not resolve: "./missing.ts"`);
		expect(await fs.exists(path.join(broken, "dist/server/manifest.json"))).toBe(false);
	});

	describe("production server", () => {
		let app: Awaited<ReturnType<typeof serve>>;

		beforeAll(async () => {
			// from another folder: the bundle finds its files by its own location
			app = await serve(["bun", dist("server/app.js")], os.tmpdir());
		});

		test("serves hashed files as immutable", async () => {
			for (const file of hashed(built.files)) {
				const res = await app.get("/" + file);
				expect(res.status).toBe(200);
				expect(res.headers.get("cache-control")).toBe("public, immutable, max-age=31536000");
				expect(await res.bytes()).toEqual(await Bun.file(dist("client", file)).bytes());
			}
		});

		test("serves public files at their path, not as immutable", async () => {
			for (const file of publicFiles.filter((file) => file !== "own")) {
				const res = await app.get("/" + file);
				expect(res.status).toBe(200);
				expect(res.headers.get("cache-control")).toBeNull();
				expect(await res.text()).toBe(files["public/" + file] as string);
			}
			expect((await app.get("/icons/favicon.svg")).headers.get("content-type")).toStartWith("image/svg+xml");
		});

		test("the app's routes come before public files", async () => {
			expect(await app.text("/own")).toBe("own route");
		});

		test("sends each file's content type", async () => {
			const type = async (url: string) => (await app.get(url)).headers.get("content-type");
			expect(await type(built.entries["src/client/a.ts"]!.scripts[0]!)).toStartWith("text/javascript");
			expect(await type(built.entries["src/client/main.css"]!.styles[0]!)).toStartWith("text/css");
			expect(await type("/" + built.files.find((file) => file.endsWith(".woff2")))).toBe("font/woff2");
		});

		test("`client.head()` has every entry's tags, each once", async () => {
			const html = await app.text("/head");
			const { entries } = built;
			const all = Object.values(entries);
			expect(scripts(html).sort()).toEqual(all.flatMap((e) => e.scripts).sort());
			expect(styles(html).sort()).toEqual(all.flatMap((e) => e.styles).sort());
			expect(preloads(html)).toEqual(entries["src/client/a.ts"]!.preloads);
		});

		test("`client.head(entry)` has only that entry's tags", async () => {
			const html = await app.text("/head?e=src/client/b.ts");
			const b = built.entries["src/client/b.ts"]!;
			expect(scripts(html)).toEqual(b.scripts);
			expect(preloads(html)).toEqual(b.preloads);
			expect(styles(html)).toEqual([]);
		});

		test("`client.head()` takes entries as `build()` got them", async () => {
			expect(await app.text("/head?e=./src/client/b.ts")).toBe(await app.text("/head?e=src/client/b.ts"));
		});

		test("`client.head()` puts stylesheets before preloads before scripts", async () => {
			const html = await app.text("/head?e=src/client/a.ts");
			expect(html).toMatch(/^<link rel="stylesheet"[^>]+><link rel="modulepreload"[^>]+><script /);
		});

		test("`client.head()` throws for an unknown entry", async () => {
			const res = await app.get("/head?e=src/client/missing.ts");
			expect(res.status).toBe(400);
			expect(await res.text()).toContain(`"src/client/missing.ts" is not a client entry point`);
		});

		test("`client.head()` has no reload script", async () => {
			const html = await app.text("/head");
			expect(html).not.toContain("WebSocket");
			expect(html).not.toContain("_crumpet");
		});

		test("`client.url()` is the hashed file", async () => {
			const url = await app.text("/font");
			expect(url).toMatch(/^\/_immutable\/font-\w+\.woff2$/);
			expect(await (await app.get(url)).bytes()).toEqual(font);
		});

		test("keeps the app's routes, `fetch` and text imports", async () => {
			expect(await app.text("/own")).toBe("own route");
			expect(await app.text("/note")).toBe("# a note\n");
			expect((await app.get("/nothing")).status).toBe(404);
		});

		test("keeps the app's WebSocket handler", async () => {
			const { ws, messages } = await socket(app.origin + "/ws");
			ws.send("hi");
			await until(() => messages.length);
			expect(messages).toEqual(["echo:hi"]);
			ws.close();
		});

		test("turns development mode off", async () => {
			expect(await app.text("/development")).toBe("false");
		});

		test("has no dev routes", async () => {
			expect((await app.get("/_crumpet/file/src/client/font.woff2")).status).toBe(404);
			expect((await app.get("/_crumpet/reload")).status).toBe(404);
		});
	});
});

describe("development", () => {
	let dir: string;
	let app: Awaited<ReturnType<typeof serve>>;
	let reload: Awaited<ReturnType<typeof socket>>;
	const write = (file: string, text: string) => Bun.write(path.join(dir, file), text);

	/** The next reload message after `change`. */
	const reloaded = async (change: () => Promise<unknown>) => {
		const before = reload.messages.length;
		await change();
		await until(() => reload.messages.length > before);
	};

	beforeAll(async () => {
		dir = await fixture();
		app = await serve(["bun", "--watch", "build.ts"], dir);
		reload = await socket(app.origin + "/_crumpet/reload");
	});

	test("writes nothing to disk", async () => {
		expect(await fs.exists(path.join(dir, "dist"))).toBe(false);
		expect(await fs.exists(path.join(dir, ".vercel"))).toBe(false);
	});

	test("turns development mode on", async () => {
		expect(await app.text("/development")).toBe("true");
	});

	test("`client.head()` has every entry's tags and the reload script", async () => {
		const html = await app.text("/head");
		expect(scripts(html)).toHaveLength(2);
		expect(styles(html)).toHaveLength(2);
		expect(preloads(html)).toHaveLength(1);
		expect(html).toEndWith("</script>");
		expect(html).toContain(`new WebSocket(location.origin.replace("http","ws")+"/_crumpet/reload")`);
	});

	test("`client.head(entry)` has only that entry's tags, and the reload script", async () => {
		const html = await app.text("/head?e=./src/client/b.ts");
		expect(scripts(html)).toEqual([expect.stringMatching(/^\/_immutable\/b-\w+\.js$/)]);
		expect(styles(html)).toEqual([]);
		expect(html).toContain("/_crumpet/reload");
	});

	test("`client.head()` throws for an unknown entry", async () => {
		expect((await app.get("/head?e=src/client/missing.ts")).status).toBe(400);
	});

	test("serves the client build from memory, uncached, with source maps", async () => {
		const html = await app.text("/head");
		for (const url of [...scripts(html), ...styles(html), ...preloads(html)]) {
			const res = await app.get(url);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-cache");
		}
		const js = await app.text(scripts(html)[0]!);
		expect(js).toContain("sourceMappingURL=data:");
		expect(js).toContain("\n");
	});

	test("`client.url()` is a dev route for the file", async () => {
		const url = await app.text("/font");
		expect(url).toBe("/_crumpet/file/src/client/font.woff2");
		const res = await app.get(url);
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(await res.bytes()).toEqual(font);
	});

	test("serves no file `client.url()` hasn't returned", async () => {
		for (const file of [
			"build.ts",
			"tsconfig.json",
			"src/server/app.ts",
			"src/client/a.ts",
			"src/client/../client/a.ts",
			"..%2F..%2Fetc%2Fhosts",
			"%2Fetc%2Fhosts",
		]) {
			expect((await app.get("/_crumpet/file/" + file)).status).toBe(404);
		}
	});

	test("keeps the app's routes, `fetch` and text imports", async () => {
		expect(await app.text("/own")).toBe("own route");
		expect(await app.text("/note")).toBe("# a note\n");
		expect((await app.get("/nothing")).status).toBe(404);
	});

	test("keeps the app's WebSocket handler next to the reload socket", async () => {
		const before = reload.messages.length;
		const { ws, messages } = await socket(app.origin + "/ws");
		ws.send("hi");
		await until(() => messages.length);
		expect(messages).toEqual(["echo:hi"]);
		// the reload socket's messages don't reach the app, or the app's it
		reload.ws.send("not for the app");
		await Bun.sleep(50);
		expect(reload.messages.length).toBe(before);
		ws.close();
	});

	test("serves public files at their path, uncached", async () => {
		for (const file of publicFiles.filter((file) => file !== "own")) {
			const res = await app.get("/" + file);
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toBe("no-cache");
			expect(await res.text()).toBe(files["public/" + file] as string);
		}
		expect(await app.text("/own")).toBe("own route");
	});

	test("serves a public file's edits, and files added to the folder", async () => {
		await write("public/robots.txt", "User-agent: edited\n");
		await until(async () => (await app.text("/robots.txt")) === "User-agent: edited\n");
		await reloaded(() => write("public/new/file.txt", "new"));
		expect(await app.text("/new/file.txt")).toBe("new");
	});

	test("a request that isn't a WebSocket gets a 400 from the reload route", async () => {
		expect((await app.get("/_crumpet/reload")).status).toBe(400);
	});

	test("rebuilds and reloads when a client file changes", async () => {
		const before = await app.text("/head?e=src/client/b.ts");
		await reloaded(() => write("src/client/b.ts", `console.log("entry b, edited");\n`));
		const after = await app.text("/head?e=src/client/b.ts");
		expect(after).not.toBe(before);
		expect(await app.text(scripts(after)[0]!)).toContain("entry b, edited");
		// the build before it is gone
		expect((await app.get(scripts(before)[0]!)).status).toBe(404);
	});

	test("rebuilds when a file outside the entries' folder changes", async () => {
		await reloaded(() => write("src/lib/shared.ts", `export const shared = "edited-shared";\n`));
		const html = await app.text("/head?e=src/client/a.ts");
		const js = (await Promise.all([...scripts(html), ...preloads(html)].map(app.text))).join("");
		expect(js).toContain("edited-shared");
	});

	test("rebuilds when CSS changes", async () => {
		await reloaded(() => write("src/client/a.css", ".a { color: rebeccapurple; }\n"));
		const html = await app.text("/head?e=src/client/a.ts");
		expect(await app.text(styles(html)[0]!)).toContain("#639");
	});

	test("keeps serving the last build when the client doesn't build", async () => {
		const before = await app.text("/head?e=src/client/a.ts");
		await reloaded(() => write("src/client/a.ts", "const = ;"));
		expect(await app.text("/head?e=src/client/a.ts")).toBe(before);
		expect((await app.get(scripts(before)[0]!)).status).toBe(200);

		await reloaded(() => write("src/client/a.ts", `console.log("entry a, fixed");\n`));
		const after = await app.text("/head?e=src/client/a.ts");
		expect(await app.text(scripts(after)[0]!)).toContain("entry a, fixed");
	});

	test("restarts when server code changes, and the reload socket closes", async () => {
		const closed = new Promise((resolve) => (reload.ws.onclose = resolve));
		const source = files["src/server/app.ts"] as string;
		await write("src/server/app.ts", source.replace("own route", "own route, edited"));
		await until(async () => (await app.text("/own")) === "own route, edited");
		await closed;
		// pages reload by opening the socket again
		const again = await until(() => socket(app.origin + "/_crumpet/reload").catch(() => undefined));
		again.ws.close();
		expect(await app.text("/font")).toBe("/_crumpet/file/src/client/font.woff2");
	});

	test("listens on localhost and prints the address", async () => {
		app.proc.kill();
		await app.proc.exited;
		const stdout = await new Response(app.proc.stdout as ReadableStream).text();
		expect(stdout).toContain(`crumpet dev  ${app.origin}/  ready in`);
		expect(stdout).toContain("client rebuilt in");
	});

	test("warns when it isn't run with `bun --watch`", async () => {
		const other = await serve(["bun", "build.ts"], await fixture(), { DEV: "1" });
		other.proc.kill();
		await other.proc.exited;
		expect(await new Response(other.proc.stderr as ReadableStream).text()).toContain(
			"run the dev server with `bun --watch`",
		);
	});
});

// A client plugin, in the build and in dev. The plugin and Tailwind come from
// the example's packages: run `bun install` in `example/` for these to run.
const packages = path.join(import.meta.dir, "../example/node_modules");
const installed = await fs.exists(path.join(packages, "bun-plugin-tailwind"));

describe.skipIf(!installed)("a client plugin (Tailwind)", () => {
	const page = (classes: string) => `export const page = '<h1 class="${classes}">crumpet</h1>';\n`;

	const tailwind = async () => {
		const dir = await fixture({
			"build.ts": (files["build.ts"] as string)
				.replace(`import {`, `import tailwind from "bun-plugin-tailwind";\nimport {`)
				.replace(`client: {`, `client: { plugins: [tailwind],`),
			"src/client/main.css": `@import "tailwindcss";\n`,
			"src/server/page.ts": page("underline text-3xl"),
			"src/server/app.ts": `import "./page.ts";\n` + files["src/server/app.ts"],
		});
		await fs.symlink(packages, path.join(dir, "node_modules"));
		return dir;
	};

	/** A rule for the class, as Tailwind writes it. */
	const rule = (name: string) => new RegExp(`\\.${name}\\s*\\{`);

	test("builds the classes the app uses into the stylesheet", async () => {
		const dir = await tailwind();
		const { code, stderr } = await run(["bun", "build.ts"], dir);
		expect(stderr).toBe("");
		expect(code).toBe(0);

		const built: Built = await Bun.file(path.join(dir, "dist/server/manifest.json")).json();
		const url = built.entries["src/client/main.css"]!.styles[0]!;
		const css = await Bun.file(path.join(dir, "dist/client", url)).text();
		expect(css).toMatch(rule("underline"));
		expect(css).toMatch(rule("text-3xl"));
		expect(css).not.toMatch(rule("line-through"));
		expect(css).not.toContain("@import");
	});

	test("rebuilds the stylesheet in development", async () => {
		const dir = await tailwind();
		const app = await serve(["bun", "--watch", "build.ts"], dir);
		const css = async () => app.text(styles(await app.text("/head?e=src/client/main.css"))[0]!);
		expect(await css()).toMatch(rule("underline"));
		expect(await css()).not.toMatch(rule("line-through"));

		// a class in client code: the client rebuilds
		const reload = await socket(app.origin + "/_crumpet/reload");
		await Bun.write(path.join(dir, "src/client/b.ts"), `document.body.className = "line-through";\n`);
		await until(() => reload.messages.length);
		expect(await css()).toMatch(rule("line-through"));

		// a class in server code: the server restarts, with a new client build
		expect(await css()).not.toMatch(rule("italic"));
		await Bun.write(path.join(dir, "src/server/page.ts"), page("underline italic"));
		await until(async () => rule("italic").test(await css()));
		expect(await css()).not.toMatch(rule("text-3xl"));
	});
});
