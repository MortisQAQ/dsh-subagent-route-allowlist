
import z from "file:///D:/dsh-home/profiles/desktop/node_modules/@deepseek-ai/schemastery/lib/index.mjs";
const RouteSchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});

const Config = z.object({
	/** Master switch. When false the plugin registers but records nothing. */
	enabled: z.boolean().default(true),
	/** Always allow the route this Session itself runs on. */
	includeSessionRoute: z.boolean().default(true),
	/** Also record a policy for Sessions that already have history (resumed). */
	includeResumed: z.boolean().default(true),
	/** Let child Sessions inherit the parent policy (the settings plugin also does this). */
	inheritForSubagents: z.boolean().default(true),
	/** Hard cap on the recorded route count. */
	maxRoutes: z.natural().default(40),
	/** Routes always present, regardless of discovery. */
	explicit: z.array(RouteSchema).default([]),
	/** Routes never recorded. */
	exclude: z.array(RouteSchema).default([]),
	discovery: z.object({
		/** Query the LLM runtime for advertised models. */
		enabled: z.boolean().default(true),
		/** Provider ids, or ["*"] for every registered provider. */
		providers: z.array(z.string().min(1)).default(["*"]),
		/** Per-provider catalog lookup budget. */
		timeoutMs: z.natural().default(1500),
		/** How long a provider catalog is reused. */
		cacheTtlMs: z.natural().default(300000)
	}).default({
		enabled: true,
		providers: ["*"],
		timeoutMs: 1500,
		cacheTtlMs: 300000
	})
});



const parsed = Config({});
console.log("defaults:", JSON.stringify(parsed));
const custom = Config({
  discovery: { providers: ["easy-cliproxyapi"] },
  explicit: [{ provider: "easy-cliproxyapi", model: "deepseek-v4.1-flash" }],
  maxRoutes: 12,
});
console.log("custom:", JSON.stringify(custom));
try { Config({ explicit: [{ provider: "", model: "x" }] }); console.log("FAIL empty provider accepted"); }
catch (e) { console.log("PASS empty provider rejected:", e.message.split("\n")[0]); }
try { Config({ discovery: { providers: [] } }); console.log("note: empty providers accepted (means no discovery)"); }
catch (e) { console.log("empty providers rejected"); }
