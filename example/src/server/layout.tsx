import { client } from "crumpet";
import { Render, type JSX } from "ovr";
import font from "@/client/fonts/font.woff2";

export const Layout = (props: { title: string; children?: JSX.Element }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>{props.title} | crumpet</title>
			<link rel="preload" href={client.url(font)} as="font" type="font/woff2" crossorigin="anonymous" />
			{Render.raw({ markup: client.head() })}
		</head>
		<body>{props.children}</body>
	</html>
);
