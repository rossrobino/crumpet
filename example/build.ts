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
