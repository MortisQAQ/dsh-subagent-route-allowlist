
const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain });
const z = chain;
const SessionSeq = (n) => n;
const parentAgentOptionsForDelegation = (agent) => agent.options;

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


// ---------------- test harness ----------------
let ACTIVE_POLICIES = null;
function makeCtx({ providers = [], catalogs = {}, failProviders = [] } = {}) {
  const policies = new Map();
  ACTIVE_POLICIES = policies;
  const sessions = new Map();
  const handlers = [];
  const log = [];
  const llm = {
    listProviders: () => providers.map((id) => ({ id, name: id })),
    listModels: async (provider) => {
      if (failProviders.includes(provider)) throw new Error("boom " + provider);
      return (catalogs[provider] ?? []).map((id) => ({ id, name: id }));
    },
  };
  const ctx = {
    sessionProjections: { register: async () => ({ stateOf: (s) => policies.get(s) }) },
    sessions: { get: (id) => sessions.get(id) },
    get: (name) => (name === "llm" ? llm : undefined),
    logger: { warn: (...a) => log.push(["warn", ...a]), debug: (...a) => log.push(["debug", ...a]), info: () => {} },
    on: (event, fn) => { if (event === "agent/created") handlers.push(fn); },
  };
  return { ctx, policies, sessions, handlers, log };
}

function makeSession({ id, origin = "main", parent, options = {}, firstLiveSeq = 0, firstType = "session/seed" }) {
  const events = [];
  const session = {
    id,
    header: { origin, parentSession: parent },
    firstLiveSeq,
    options,
    eventAt: (seq) => (seq === 0 ? { type: firstType } : undefined),
    append(type, data) {
      events.push({ type, data });
      if (type === "subagent/model-selection-policy" && !ACTIVE_POLICIES.get(session)) {
        ACTIVE_POLICIES.set(session, data.allowedModels);
      }
    },
    events,
  };
  return session;
}

const results = [];
function check(label, cond, detail) {
  results.push((cond ? "PASS " : "FAIL ") + label + (cond ? "" : " :: " + JSON.stringify(detail)));
}

async function run() {
  // --- 1. fresh session, discovery + session route + dedupe
  {
    const { ctx, handlers, policies, sessions } = makeCtx({
      providers: ["easy-cliproxyapi", "a6apo"],
      catalogs: { "easy-cliproxyapi": ["deepseek-v4.1-flash", "gpt-6.1-sol"], "a6apo": ["gpt-6.1-sol", "gemini-4-argon"] },
    });
    await apply(ctx, {
      enabled: true, includeSessionRoute: true, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const s = makeSession({ id: "s1", options: { provider: "easy-cliproxyapi", model: "deepseek-v4.1-flash" } });
    sessions.set("s1", s);
    await handlers[0]({ agent: { session: s, options: s.options } });
    const routes = policies.get(s);
    check("discovers + keeps session route", routes.length === 4, routes);
    check("dedupes repeated route", new Set(routes.map(r => r.provider + "/" + r.model)).size === routes.length, routes);
    check("session route present", routes.some(r => r.provider === "easy-cliproxyapi" && r.model === "deepseek-v4.1-flash"), routes);
  }

  // --- 2. exclude + explicit + maxRoutes
  {
    const { ctx, handlers, policies, sessions } = makeCtx({
      providers: ["p1"],
      catalogs: { p1: ["a", "b", "c", "d"] },
    });
    await apply(ctx, {
      enabled: true, includeSessionRoute: false, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 3, explicit: [{ provider: "p2", model: "pinned" }],
      exclude: [{ provider: "p1", model: "a" }],
      discovery: { enabled: true, providers: ["p1"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const s = makeSession({ id: "s2" });
    sessions.set("s2", s);
    await handlers[0]({ agent: { session: s, options: {} } });
    const routes = policies.get(s);
    check("explicit first, exclude applied, cap respected", routes.length === 3 && routes[0].provider === "p2" && !routes.some(r => r.model === "a"), routes);
  }

  // --- 3. subagent inherits parent policy
  {
    const { ctx, handlers, policies, sessions } = makeCtx({ providers: [], catalogs: {} });
    await apply(ctx, {
      enabled: true, includeSessionRoute: false, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [{ provider: "x", model: "y" }], exclude: [],
      discovery: { enabled: false, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const parent = makeSession({ id: "p" });
    sessions.set("p", parent);
    await handlers[0]({ agent: { session: parent, options: {} } });
    const child = makeSession({ id: "c", origin: "subagent", parent: "p" });
    sessions.set("c", child);
    await handlers[0]({ agent: { session: child, options: {} } });
    const inherited = policies.get(child);
    check("subagent inherits parent policy", Array.isArray(inherited) && inherited.length === 1 && inherited[0].model === "y", inherited);
  }

  // --- 4. already has a policy -> untouched
  {
    const { ctx, handlers, policies, sessions } = makeCtx({ providers: ["p1"], catalogs: { p1: ["m"] } });
    await apply(ctx, {
      enabled: true, includeSessionRoute: false, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const s = makeSession({ id: "s4" });
    sessions.set("s4", s);
    policies.set(s, [{ provider: "keep", model: "me" }]);
    await handlers[0]({ agent: { session: s, options: {} } });
    check("existing policy is left alone", s.events.length === 0, s.events);
  }

  // --- 5. resumed session without policy gets one; includeResumed=false skips
  {
    const { ctx, handlers, policies, sessions } = makeCtx({ providers: ["p1"], catalogs: { p1: ["m"] } });
    await apply(ctx, {
      enabled: true, includeSessionRoute: false, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const resumed = makeSession({ id: "s5", firstLiveSeq: 12 });
    sessions.set("s5", resumed);
    await handlers[0]({ agent: { session: resumed, options: {} } });
    check("resumed session gets a policy", Array.isArray(policies.get(resumed)), policies.get(resumed));

    const { ctx: ctx2, handlers: h2, policies: p2, sessions: s2 } = makeCtx({ providers: ["p1"], catalogs: { p1: ["m"] } });
    await apply(ctx2, {
      enabled: true, includeSessionRoute: false, includeResumed: false, inheritForSubagents: true,
      maxRoutes: 40, explicit: [], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const r2 = makeSession({ id: "s6", firstLiveSeq: 12 });
    s2.set("s6", r2);
    await h2[0]({ agent: { session: r2, options: {} } });
    check("includeResumed=false skips resumed", p2.get(r2) === undefined, r2.events);
  }

  // --- 6. discovery failure does not break; disabled plugin records nothing
  {
    const { ctx, handlers, policies, sessions, log } = makeCtx({ providers: ["bad"], catalogs: {}, failProviders: ["bad"] });
    await apply(ctx, {
      enabled: true, includeSessionRoute: true, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [{ provider: "ok", model: "fine" }], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const s = makeSession({ id: "s7", options: { provider: "ok", model: "fine" } });
    sessions.set("s7", s);
    await handlers[0]({ agent: { session: s, options: s.options } });
    check("catalog failure degrades gracefully", Array.isArray(policies.get(s)) && policies.get(s).length === 1, { routes: policies.get(s), log });

    const d = makeCtx({ providers: ["p1"], catalogs: { p1: ["m"] } });
    await apply(d.ctx, {
      enabled: false, includeSessionRoute: false, includeResumed: true, inheritForSubagents: true,
      maxRoutes: 40, explicit: [], exclude: [],
      discovery: { enabled: true, providers: ["*"], timeoutMs: 500, cacheTtlMs: 60000 },
    });
    const s8 = makeSession({ id: "s8" });
    d.sessions.set("s8", s8);
    await d.handlers[0]({ agent: { session: s8, options: {} } });
    check("disabled plugin records nothing", s8.events.length === 0, s8.events);
  }

  console.log(results.join("\n"));
  const failed = results.filter((r) => r.startsWith("FAIL")).length;
  console.log("\n" + (results.length - failed) + "/" + results.length + " passed");
  if (failed > 0) process.exitCode = 1;
}
run().catch((e) => { console.error("HARNESS ERROR", e); process.exitCode = 1; });
