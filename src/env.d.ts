// Types crumpet would ship, like domco/env: file imports are URLs, text imports are strings.
declare module "*.woff2" {
	const url: string;
	export default url;
}
declare module "*.svg" {
	const url: string;
	export default url;
}
declare module "*.md" {
	const text: string;
	export default text;
}
