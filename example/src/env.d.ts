// Types for the files this app imports. Bun declares only a few extensions
// (`.txt`, `.toml`, `.yaml`, `.html` and so on), so the app declares the rest.

// file imports: a URL in the build, a path in dev (see `client.url()`)
declare module "*.woff2" {
	const url: string;
	export default url;
}
declare module "*.svg" {
	const url: string;
	export default url;
}
// imported `with { type: "text" }`
declare module "*.md" {
	const text: string;
	export default text;
}
