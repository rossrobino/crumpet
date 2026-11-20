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

// what Bun serves: `bun src/server/app.tsx` works too, without the client files
export default {
	// ovr takes the client IP as an option; Bun has it on the server
	fetch: (req, server) => app.fetch(req, { ip: server.requestIP(req)?.address }),
} satisfies Bun.Serve.Options<undefined>;
