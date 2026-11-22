import { client } from "crumpet";
import { Render, type JSX } from "ovr";
import font from "@/client/fonts/font.woff2";
import icon from "@/client/icon.svg";

export const Layout = (props: { title: string; children?: JSX.Element }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>{props.title} | crumpet</title>
			{/* file imports' URLs: the font is the same file the CSS uses */}
			<link rel="preload" href={client.url(font)} as="font" type="font/woff2" crossorigin="anonymous" />
			<link rel="icon" href={client.url(icon)} type="image/svg+xml" />
			{Render.raw({ markup: client.head() })}
		</head>
		<body>{props.children}</body>
	</html>
);
