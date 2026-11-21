import { client } from "crumpet";
import { Render, type JSX } from "ovr";
import icon from "@/client/icon.svg";

export const Layout = (props: { title: string; children?: JSX.Element }) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<title>{props.title} | crumpet</title>
			{/* a file import's URL. The font isn't preloaded: Bun inlines it into the CSS. */}
			<link rel="icon" href={client.url(icon)} type="image/svg+xml" />
			{Render.raw({ markup: client.head() })}
		</head>
		<body>{props.children}</body>
	</html>
);
