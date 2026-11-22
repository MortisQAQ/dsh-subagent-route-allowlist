/**
 * dsh-subagent-route-allowlist
 *
 * Builds the per-Session "allowed child models" list at session start instead of
 * hand-maintaining it in YAML.
 *
 * Why this exists
 * ---------------
 * @deepseek-ai/dsh-tool-subagent with modelSelection: true accepts
 * provider / model / reasoning_effort on the subagent call, but it only honours
 * a route the Session recorded in its durable subagent/model-selection-policy
 * projection event:
 *
 *   - no policy event -> only the parent route may be named explicitly;
 *   - policy event    -> ONLY the listed (provider, model) pairs.
 *
 * That projection is first-write-wins, so it can only be recorded at session
 * start -- which is what @deepseek-ai/dsh-tool-subagent/model-selection-settings
 * does from a static config list. This plugin replaces the static list with a
 * computed one:
 *
 *   1. the session's own route (naming it explicitly is then never rejected),
 *   2. explicitly pinned routes,
 *   3. every model the LLM runtime advertises for the selected providers,
 *   4. minus exclude, capped at maxRoutes.
 *
 * The policy carries routes only. Reasoning effort is not part of it: a per-call
 * reasoning_effort is validated by the LLM runtime against the model's own
 * advertised efforts (e.g. deepseek-v4.1-flash advertises max).
 *
 * @module dsh-subagent-route-allowlist
 */
import z from "@deepseek-ai/schemastery";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { parentAgentOptionsForDelegation } from "@deepseek-ai/dsh-subagent";

export const name = "subagent-route-allowlist";
export const inject = ["sessionProjections", "sessions"];

/** Durable projection key owned by dsh-tool-subagent; shared by reference count. */
const PROJECTION_KEY = "subagentModelSelectionPolicy";
/** The one event that seeds the projection. */
const EVENT_TYPE = "subagent/model-selection-policy";

const RouteSchema = z.object({
	provider: z.string().min(1).required(),
	model: z.string().min(1).required()
});

export const Config = z.object({
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

/**
 * Host-only state schema for the shared projection.
 *
 * A hand-rolled parse keeps this package free of a zod dependency: the registry
 * only calls stateSchema.parse on checkpoint/restore paths, and the built-in
 * settings plugin (which registers the same key) keeps its own schema.
 */
const routeStateSchema = {
	parse(value) {
		if (value === null) return null;
		if (!Array.isArray(value) || value.length === 0) {
			throw new Error("subagent model selection policy must be a non-empty route array");
		}
		return value.map((route) => {
			if (route === null || typeof route !== "object") {
				throw new Error("subagent model selection policy entries must be objects");
			}
			if (typeof route.provider !== "string" || route.provider.length === 0) {
				throw new Error("subagent model selection policy requires a non-empty provider");
			}
			if (typeof route.model !== "string" || route.model.length === 0) {
				throw new Error("subagent model selection policy requires a non-empty model");
			}
			return { provider: route.provider, model: route.model };
		});
	}
};

const projectionDefinition = {
	key: PROJECTION_KEY,
	stateVersion: 1,
	stateSchema: routeStateSchema,
	init: () => null,
	apply: (policy, event) => {
		// First write wins: a Session can never widen or narrow its list later.
		if (policy !== null || event.type !== EVENT_TYPE) return policy;
		const routes = routeStateSchema.parse(event.data?.allowedModels);
		if (routes.length === 0) throw new Error("subagent/model-selection-policy requires at least one route");
		return routes;
	}
};

/** provider id -> { at, models } catalog cache shared by every Session. */
const catalogCache = new Map();

function routeKey(provider, model) {
	return provider + "\u0000" + model;
}

/** Run one catalog lookup under a budget; a late rejection stays handled. */
async function withTimeout(run, ms) {
	let timer;
	try {
		return await Promise.race([
			run(),
			new Promise((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("model catalog lookup timed out after " + ms + "ms")), ms);
				if (typeof timer.unref === "function") timer.unref();
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Read one provider's advertised model ids, reusing a recent catalog. */
async function discoverModels(ctx, provider, discovery) {
	const now = Date.now();
	const cached = catalogCache.get(provider);
	if (cached !== undefined && now - cached.at < discovery.cacheTtlMs) return cached.models;
	const llm = ctx.get("llm");
	if (llm === undefined) return cached === undefined ? [] : cached.models;
	try {
		const listed = await withTimeout(() => llm.listModels(provider), discovery.timeoutMs);
		const models = (Array.isArray(listed) ? listed : [])
			.map((model) => (model === null || model === undefined ? undefined : model.id))
			.filter((id) => typeof id === "string" && id.length > 0);
		catalogCache.set(provider, { at: now, models });
		return models;
	} catch (error) {
		const stale = cached === undefined ? [] : cached.models;
		ctx.logger?.warn("subagent-route-allowlist: cannot read the \"" + provider + "\" model catalog (" + String(error && error.message ? error.message : error) + "); using " + stale.length + " cached route(s)");
		return stale;
	}
}

/** Compute the route list for one Session. */
async function buildRoutes(ctx, config, agent) {
	const excluded = new Set(config.exclude.map((route) => routeKey(route.provider, route.model)));
	const seen = new Set();
	const routes = [];
	const push = (provider, model) => {
		if (typeof provider !== "string" || provider.length === 0) return;
		if (typeof model !== "string" || model.length === 0) return;
		const key = routeKey(provider, model);
		if (seen.has(key) || excluded.has(key)) return;
		seen.add(key);
		routes.push({ provider, model });
	};

	for (const route of config.explicit) push(route.provider, route.model);

	if (config.includeSessionRoute) {
		try {
			const options = parentAgentOptionsForDelegation(agent);
			push(options === undefined || options === null ? undefined : options.provider, options === undefined || options === null ? undefined : options.model);
		} catch {
			/* a Session without a resolved route simply contributes nothing */
		}
	}

	const discovery = config.discovery;
	if (discovery !== undefined && discovery.enabled) {
		const llm = ctx.get("llm");
		let providers = [];
		if (llm !== undefined) {
			providers = discovery.providers.includes("*")
				? llm.listProviders().map((provider) => provider.id)
				: discovery.providers.slice();
		}
		for (const provider of providers) {
			const models = await discoverModels(ctx, provider, discovery);
			for (const model of models) push(provider, model);
		}
	}

	return routes.slice(0, config.maxRoutes);
}

export async function apply(ctx, config) {
	const handle = await ctx.sessionProjections.register(projectionDefinition);

	ctx.on("agent/created", async ({ agent }) => {
		try {
			if (!config.enabled) return;
			const target = agent.session;
			if (handle.stateOf(target) !== undefined) return;

			// A seeded/ended Session is never a place to record a policy.
			if (target.firstLiveSeq === 0 && target.eventAt(SessionSeq(0))?.type === "session/end-seed") return;

			const parentId = target.header.origin === "subagent" ? target.header.parentSession : undefined;
			if (parentId !== undefined) {
				if (!config.inheritForSubagents) return;
				const parent = ctx.sessions.get(parentId);
				if (parent === undefined) return;
				const inherited = handle.stateOf(parent);
				if (inherited === undefined || inherited.length === 0) return;
				target.append(EVENT_TYPE, { allowedModels: inherited.map((route) => ({ provider: route.provider, model: route.model })) });
				return;
			}

			const fresh = target.firstLiveSeq === 0;
			if (!fresh && !config.includeResumed) return;

			const routes = await buildRoutes(ctx, config, agent);
			if (routes.length === 0) {
				ctx.logger?.warn("subagent-route-allowlist: computed an empty allowlist; the Session keeps parent-route-only child selection");
				return;
			}
			if (handle.stateOf(target) !== undefined) return;
			target.append(EVENT_TYPE, { allowedModels: routes });
			ctx.logger?.debug("subagent-route-allowlist: recorded " + routes.length + " child route(s) for session " + target.id);
		} catch (error) {
			// Never fail session creation because of the allowlist.
			ctx.logger?.warn("subagent-route-allowlist: could not record a policy (" + String(error && error.message ? error.message : error) + ")");
		}
	});
}
