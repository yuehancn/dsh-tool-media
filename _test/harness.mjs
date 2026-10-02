// Shared minimal harness for the dsh-tool-media tests.
//
// It rebuilds the plugin's `apply` against the REAL @deepseek-ai/dsh-tools, so
// schema normalization (`required` hoisting, `additionalProperties`, description
// retention) is exercised for real rather than against a hand-written stub.
//
// `apply(ctx, config)` in the plugin receives an already schema-resolved config,
// so this context runs the caller's options through the real `Config` first and
// fills any missing key with its default. Passing a partial object straight
// through would silently register zero tools.
import { readFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

// Present the plugin's real exports under an object, built by evaluating the
// module body with its bare imports bound to the real modules above.
const body = source
	.replace(/^import .*$/gm, "")
	.replace(/^export \{.*\};$/m, "");
const build = new Function(
	"z", "defineTool", "mkdir", "readdir", "stat",
	"join", "resolve", "basename", "extname", "spawn",
	`${body}\nreturn { Config, apply, inject, name };`
);
const { mkdir, readdir, stat } = await import("node:fs/promises");
const { join, resolve, basename, extname } = await import("node:path");
const { spawn } = await import("node:child_process");

/** The plugin's real exports, with imports wired to genuine modules. */
export const plugin = build(z, defineTool, mkdir, readdir, stat, join, resolve, basename, extname, spawn);

/**
 * Build a minimal cordis-like context that records registered tools.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {{tools: object, config: object, names: () => string[], get: (n: string) => any}} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		/** True when the named tool was registered. */
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call and capture either its value or the thrown error, so tests can
 * assert on modelled failure paths without try/catch noise.
 *
 * @param {any} definition - a tool definition whose signature has `execute`.
 * @param {object} args - tool arguments.
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args) {
	try {
		return { value: await definition.execute(args, { signal: undefined }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

// `Context()` above is a builder, but test-integration.mjs uses it as a plain
// factory with and without options — both shapes must work.
export default { plugin, Context, call };