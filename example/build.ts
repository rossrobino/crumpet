import { build, vercel } from "crumpet";

// `bun --watch build.ts` runs the dev server, `bun build.ts` builds
const development = process.execArgv.includes("--watch");

if (!development) {
	// extra build steps go here, for example (with `$` from "bun"):
	// await $`tailwindcss -i src/styles/input.css -o src/client/main.css`;
}

await build({
	development,
	server: "src/server/app.tsx",
	client: { entrypoints: ["src/client/main.ts", "src/client/main.css"] },
});

// on Vercel, also write its build output from `dist/`
await vercel();
