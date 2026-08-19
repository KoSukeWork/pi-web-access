import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";

type ResolvedSearchProvider =
	| "openai" | "brave" | "parallel" | "parallel-mcp" | "tinyfish" | "search1api"
	| "searchinfinity" | "querit" | "tavily" | "firecrawl" | "jina" | "serpdive"
	| "kagi" | "bocha" | "ollama" | "anysearch" | "xai" | "brightdata"
	| "serpbase" | "serper" | "valyu" | "perplexity" | "searxng" | "duckduckgo"
	| "gemini" | "exa";

type SearchFn = (query: string, options: SearchOptions, ctx?: ExtensionContext) => Promise<SearchResponse | null | undefined>;
type AvailableFn = (ctx?: ExtensionContext) => boolean | Promise<boolean>;

interface ProviderRuntime {
	search: SearchFn;
	available: AvailableFn;
}

const cache = new Map<ResolvedSearchProvider, Promise<ProviderRuntime>>();

function wrap(
	load: () => Promise<ProviderRuntime>,
	provider: ResolvedSearchProvider,
): Promise<ProviderRuntime> {
	let pending = cache.get(provider);
	if (!pending) {
		pending = load();
		cache.set(provider, pending);
	}
	return pending;
}

export async function loadSearchProvider(provider: ResolvedSearchProvider): Promise<ProviderRuntime> {
	switch (provider) {
		case "openai":
			return wrap(async () => {
				const m = await import("./openai-search.ts");
				return {
					search: (query, options, ctx) => m.searchWithOpenAI(query, options, ctx),
					available: (ctx) => m.isOpenAISearchAvailable(ctx),
				};
			}, provider);
		case "brave":
			return wrap(async () => {
				const m = await import("./brave.ts");
				return { search: m.searchWithBrave, available: () => m.isBraveAvailable() };
			}, provider);
		case "parallel":
			return wrap(async () => {
				const m = await import("./parallel.ts");
				return { search: m.searchWithParallel, available: () => m.isParallelAvailable() };
			}, provider);
		case "parallel-mcp":
			return wrap(async () => {
				const m = await import("./parallel-mcp.ts");
				return { search: m.searchWithParallelMcp, available: () => m.isParallelMcpAvailable() };
			}, provider);
		case "tinyfish":
			return wrap(async () => {
				const m = await import("./tinyfish.ts");
				return { search: m.searchWithTinyFish, available: () => m.isTinyFishAvailable() };
			}, provider);
		case "search1api":
			return wrap(async () => {
				const m = await import("./search1api.ts");
				return { search: m.searchWithSearch1API, available: () => m.isSearch1APIAvailable() };
			}, provider);
		case "searchinfinity":
			return wrap(async () => {
				const m = await import("./searchinfinity.ts");
				return { search: m.searchWithSearchinfinity, available: () => m.isSearchinfinityAvailable() };
			}, provider);
		case "querit":
			return wrap(async () => {
				const m = await import("./querit.ts");
				return { search: m.searchWithQuerit, available: () => m.isQueritAvailable() };
			}, provider);
		case "tavily":
			return wrap(async () => {
				const m = await import("./tavily.ts");
				return { search: m.searchWithTavily, available: () => m.isTavilyAvailable() };
			}, provider);
		case "firecrawl":
			return wrap(async () => {
				const m = await import("./firecrawl.ts");
				return { search: m.searchWithFirecrawl, available: () => m.isFirecrawlAvailable() };
			}, provider);
		case "jina":
			return wrap(async () => {
				const m = await import("./jina-search.ts");
				return { search: m.searchWithJina, available: () => m.isJinaSearchAvailable() };
			}, provider);
		case "serpdive":
			return wrap(async () => {
				const m = await import("./serpdive.ts");
				return { search: m.searchWithSerpdive, available: () => m.isSerpdiveAvailable() };
			}, provider);
		case "kagi":
			return wrap(async () => {
				const m = await import("./kagi.ts");
				return { search: m.searchWithKagi, available: () => m.isKagiAvailable() };
			}, provider);
		case "bocha":
			return wrap(async () => {
				const m = await import("./bocha.ts");
				return { search: m.searchWithBocha, available: () => m.isBochaAvailable() };
			}, provider);
		case "ollama":
			return wrap(async () => {
				const m = await import("./ollama.ts");
				return { search: m.searchWithOllama, available: () => m.isOllamaAvailable() };
			}, provider);
		case "anysearch":
			return wrap(async () => {
				const m = await import("./anysearch.ts");
				return { search: m.searchWithAnySearch, available: () => m.isAnySearchAvailable() };
			}, provider);
		case "xai":
			return wrap(async () => {
				const m = await import("./xai-search.ts");
				return {
					search: (query, options, ctx) => m.searchWithXai(query, options, ctx),
					available: (ctx) => m.isXaiSearchAvailable(ctx),
				};
			}, provider);
		case "brightdata":
			return wrap(async () => {
				const m = await import("./brightdata.ts");
				return { search: m.searchWithBrightData, available: () => m.isBrightDataAvailable() };
			}, provider);
		case "serpbase":
			return wrap(async () => {
				const m = await import("./serpbase.ts");
				return { search: m.searchWithSerpBase, available: () => m.isSerpBaseAvailable() };
			}, provider);
		case "serper":
			return wrap(async () => {
				const m = await import("./serper.ts");
				return { search: m.searchWithSerper, available: () => m.isSerperAvailable() };
			}, provider);
		case "valyu":
			return wrap(async () => {
				const m = await import("./valyu.ts");
				return { search: m.searchWithValyu, available: () => m.isValyuAvailable() };
			}, provider);
		case "perplexity":
			return wrap(async () => {
				const m = await import("./perplexity.ts");
				return { search: m.searchWithPerplexity, available: () => m.isPerplexityAvailable() };
			}, provider);
		case "searxng":
			return wrap(async () => {
				const m = await import("./searxng.ts");
				return { search: m.searchWithSearXNG, available: () => m.isSearXNGAvailable() };
			}, provider);
		case "duckduckgo":
			return wrap(async () => {
				const m = await import("./duckduckgo.ts");
				return { search: m.searchWithDuckDuckGo, available: () => m.isDuckDuckGoAvailable() };
			}, provider);
		case "gemini":
			return wrap(async () => {
				const api = await import("./gemini-api.ts");
				const web = await import("./gemini-web.ts");
				return {
					search: async () => {
						throw new Error("Gemini search is dispatched by gemini-search.ts");
					},
					available: async () => api.isGeminiApiAvailable() || !!(await web.isGeminiWebAvailable()),
				};
			}, provider);
		case "exa":
			return wrap(async () => {
				const m = await import("./exa.ts");
				return { search: m.searchWithExa, available: () => m.isExaAvailable() };
			}, provider);
		default: {
			const _never: never = provider;
			throw new Error(`Unknown search provider: ${_never}`);
		}
	}
}

export async function isLazyProviderAvailable(
	provider: ResolvedSearchProvider,
	ctx?: ExtensionContext,
): Promise<boolean> {
	const runtime = await loadSearchProvider(provider);
	return runtime.available(ctx);
}
