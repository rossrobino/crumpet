import tailwind from "bun-plugin-tailwind";
import { build, vercel } from "crumpet";

// `bun --watch build.ts` runs the dev server, `bun build.ts` builds
const development = process.execArgv.includes("--watch");

if (!development) {
	// extra build steps go here, for example (with `$` from "bun"):
	// await $`bun run generate`;
}

await build({
	development,
	server: "src/server/app.tsx",
	client: {
		entrypoints: ["src/client/main.ts", "src/client/main.css"],
		// builds the classes used in `src/` into `main.css`, in dev and in the build
		plugins: [tailwind],
	},
});

// after a build, also write Vercel's output from `dist/` (not in development)
await vercel();
