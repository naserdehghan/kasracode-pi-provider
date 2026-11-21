/**
 * KasraCode provider for Pi.
 *
 * Registers an OpenAI-compatible provider named "kasracode" whose model list is
 * discovered live from `GET {baseUrl}/models`. The API key comes from
 * `/login kasracode` (stored in ~/.pi/agent/auth.json) or the KASRACODE_API_KEY
 * environment variable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "kasracode";
const PROVIDER_NAME = "KasraCode";
const DEFAULT_BASE_URL = "https://code.kasracloud.ir/v1";
const API_KEY_ENV = "KASRACODE_API_KEY";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 32_768;
const STARTUP_FETCH_TIMEOUT_MS = 8_000;

const baseUrl = (process.env.KASRACODE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
const cachePath = process.env.KASRACODE_MODELS_CACHE || join(getAgentDir(), "kasracode-models.json");

// ---------------------------------------------------------------------------
// Shape of GET /v1/models (only the fields we read; everything is optional so
// that catalog changes never crash the extension).
// ---------------------------------------------------------------------------

interface KasraModel {
	id: string;
	name?: string;
	type?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	output_modalities?: string[];
	api_format?: string;
	supported_endpoints?: string[];
	capabilities?: {
		vision?: boolean;
		reasoning?: boolean;
		thinking?: boolean;
		supportsThinking?: boolean;
		effort_tiers?: string[];
	};
	pricing?: {
		// Per-million-token USD prices.
		input?: number;
		output?: number;
		cached?: number;
		cache_creation?: number;
		// Per-token USD prices (strings).
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
}

interface KasraModelsResponse {
	data?: KasraModel[];
}

type ChatModelConfig = Extract<ProviderModelConfig, { reasoning: boolean }>;
type ThinkingLevelMap = NonNullable<ChatModelConfig["thinkingLevelMap"]>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function positiveNumber(value: unknown): number | undefined {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Price in USD per million tokens, preferring the per-million field. */
function perMillion(perMillionValue: unknown, perTokenValue: unknown): number {
	const direct = positiveNumber(perMillionValue);
	if (direct !== undefined) return direct;
	const perToken = positiveNumber(perTokenValue);
	return perToken !== undefined ? Number((perToken * 1_000_000).toPrecision(12)) : 0;
}

/** Only text-generating chat models; image/video generators are skipped. */
function isChatModel(m: KasraModel): boolean {
	if (!m || typeof m.id !== "string" || !m.id) return false;
	if (m.type && !["chat", "text", "llm"].includes(m.type)) return false;
	const out = m.output_modalities;
	if (Array.isArray(out) && out.length > 0 && !out.includes("text")) return false;
	return true;
}

/** Models that only expose the Responses endpoint use Pi's openai-responses API. */
function pickApi(m: KasraModel): "openai-completions" | "openai-responses" {
	const endpoints = Array.isArray(m.supported_endpoints) ? m.supported_endpoints.map((e) => e.toLowerCase()) : [];
	const hasChat = endpoints.some((e) => e.includes("chat") || e.includes("completion"));
	const hasResponses = endpoints.some((e) => e.includes("responses"));
	if (!hasChat && (hasResponses || m.api_format === "responses")) return "openai-responses";
	return "openai-completions";
}

const PI_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevelMap(tiers: string[] | undefined): ThinkingLevelMap | undefined {
	if (!Array.isArray(tiers) || tiers.length === 0) return undefined;
	const map: ThinkingLevelMap = { minimal: tiers.includes("minimal") ? "minimal" : null };
	for (const level of PI_THINKING_LEVELS) map[level] = tiers.includes(level) ? level : null;
	if (tiers.includes("none")) map.off = "none";
	return map;
}

function toPiModel(m: KasraModel): ChatModelConfig {
	const caps = m.capabilities ?? {};
	const pricing = m.pricing ?? {};
	const reasoning = Boolean(caps.reasoning || caps.thinking || caps.supportsThinking);
	const vision = Boolean(caps.vision) || (m.input_modalities ?? []).includes("image");
	const contextWindow =
		positiveNumber(m.context_length) ?? positiveNumber(m.max_input_tokens) ?? DEFAULT_CONTEXT_WINDOW;
	const maxTokens = Math.min(positiveNumber(m.max_output_tokens) ?? DEFAULT_MAX_TOKENS, contextWindow);

	const model: ChatModelConfig = {
		id: m.id,
		name: m.name?.trim() || m.id,
		api: pickApi(m),
		reasoning,
		input: vision ? ["text", "image"] : ["text"],
		cost: {
			input: perMillion(pricing.input, pricing.prompt),
			output: perMillion(pricing.output, pricing.completion),
			cacheRead: perMillion(pricing.cached, pricing.input_cache_read),
			cacheWrite: perMillion(pricing.cache_creation, pricing.input_cache_write),
		},
		contextWindow,
		maxTokens,
	};
	const levels = reasoning ? thinkingLevelMap(caps.effort_tiers) : undefined;
	if (levels) model.thinkingLevelMap = levels;
	return model;
}

export function mapModels(response: KasraModelsResponse): ChatModelConfig[] {
	const seen = new Set<string>();
	const models: ChatModelConfig[] = [];
	for (const m of Array.isArray(response?.data) ? response.data : []) {
		if (!isChatModel(m) || seen.has(m.id)) continue;
		seen.add(m.id);
		models.push(toPiModel(m));
	}
	return models;
}

// ---------------------------------------------------------------------------
// Fetching + offline cache
// ---------------------------------------------------------------------------

async function fetchModels(url: string, apiKey: string, signal?: AbortSignal): Promise<ChatModelConfig[]> {
	const res = await fetch(`${url.replace(/\/+$/, "")}/models`, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal,
	});
	if (!res.ok) {
		throw new Error(`KasraCode: GET /models failed with HTTP ${res.status} ${res.statusText}`);
	}
	return mapModels((await res.json()) as KasraModelsResponse);
}

function readCache(): ChatModelConfig[] {
	try {
		if (!existsSync(cachePath)) return [];
		const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
		return Array.isArray(parsed?.models) ? parsed.models : [];
	} catch {
		return [];
	}
}

function writeCache(models: ChatModelConfig[]): void {
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		const tmp = `${cachePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), baseUrl, models }, null, 2));
		renameSync(tmp, cachePath);
	} catch {
		// Cache is best-effort; a failed write only affects offline startup.
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default async function kasracode(pi: ExtensionAPI) {
	let models = readCache();

	// First run without a cache: try a quick fetch when the key is in the environment,
	// so models are available immediately (e.g. for `pi --list-models`).
	const envKey = process.env[API_KEY_ENV];
	if (models.length === 0 && envKey) {
		try {
			models = await fetchModels(baseUrl, envKey, AbortSignal.timeout(STARTUP_FETCH_TIMEOUT_MS));
			if (models.length > 0) writeCache(models);
		} catch {
			// Fall through; refreshModels will retry in the background.
		}
	}

	pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl,
		// Enables `/login kasracode` (API-key prompt, stored in auth.json);
		// otherwise falls back to the KASRACODE_API_KEY environment variable.
		apiKey: `$${API_KEY_ENV}`,
		api: "openai-completions",
		models,

		// Called by Pi at interactive startup, when /model opens, after /login,
		// and on `pi update --models`.
		async refreshModels(context) {
			if (!context.allowNetwork) return models;
			const credential = context.credential;
			const apiKey =
				(credential?.type === "api_key" ? credential.key : undefined) || process.env[API_KEY_ENV];
			if (!apiKey) return models;

			const fresh = await fetchModels(context.baseUrl || baseUrl, apiKey, context.signal);
			if (fresh.length > 0) {
				models = fresh;
				writeCache(models);
			}
			return models;
		},
	});
}
