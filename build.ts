// Builds the package into `dist/`: `bun build.ts`
import { $ } from "bun";

await $`rm -rf dist`;

const [result] = await Promise.all([
	// minified, with a source map back to `src/`, which is published too
	Bun.build({
		entrypoints: ["src/index.ts"],
		outdir: "dist",
		target: "bun",
		minify: true,
		sourcemap: "linked",
	}),
	// Bun doesn't write type declarations, so TypeScript does, and only those
	$`tsc -p tsconfig.build.json`,
]);

for (const output of result.outputs) console.log(`${output.path.slice(process.cwd().length + 1)}  ${(output.size / 1000).toFixed(2)} kB`);
