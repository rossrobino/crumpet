import { Layout } from "./layout.tsx";
import note from "./note.md" with { type: "text" };
import { App, Route } from "ovr";

const home = Route.get("/").use((c) => (
	<Layout title="Home">
		<h1>crumpet + ovr</h1>
		<p id="ip">{c.ip ?? "no ip"}</p>
		<pre>{note}</pre>
	</Layout>
));

const app = new App().use(home);

export default app;
