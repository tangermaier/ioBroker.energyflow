import assert from "node:assert";
import { handleTaskError, runSafely, type SafeAsyncAdapter } from "./safeAsync.js";

interface FakeAdapter extends SafeAsyncAdapter {
	logs: Array<{ level: string; msg: string }>;
	captured: unknown[];
}

function fakeAdapter(withSentry = true): FakeAdapter {
	const logs: Array<{ level: string; msg: string }> = [];
	const captured: unknown[] = [];
	return {
		logs,
		captured,
		log: {
			debug: (msg: string) => logs.push({ level: "debug", msg }),
			warn: (msg: string) => logs.push({ level: "warn", msg }),
		},
		supportsFeature: () => withSentry,
		getPluginInstance: () => (withSentry ? { getSentryObject: () => ({ captureException: (e: unknown) => captured.push(e) }) } : null),
	};
}

describe("safeAsync", () => {
	it("logs a warning and reports an unexpected error to Sentry", () => {
		const adapter = fakeAdapter();
		const error = new Error("boom");
		handleTaskError(adapter, "Energy plan", error);
		assert.deepStrictEqual(adapter.logs, [{ level: "warn", msg: "Energy plan failed: boom" }]);
		assert.deepStrictEqual(adapter.captured, [error]);
	});

	it("reports the same context/message only once (no Sentry flooding from timers)", () => {
		const adapter = fakeAdapter();
		handleTaskError(adapter, "Cost sampling", new Error("same"));
		handleTaskError(adapter, "Cost sampling", new Error("same"));
		handleTaskError(adapter, "Cost sampling", new Error("other"));
		assert.strictEqual(adapter.logs.filter(l => l.level === "warn").length, 3);
		assert.strictEqual(adapter.captured.length, 2);
	});

	it("only logs at debug level for database-closed errors during shutdown", () => {
		const adapter = fakeAdapter();
		handleTaskError(adapter, "State update", new Error("DB closed"));
		handleTaskError(adapter, "State update", new Error("Connection is closed."));
		assert.ok(adapter.logs.every(l => l.level === "debug"));
		assert.strictEqual(adapter.captured.length, 0);
	});

	it("works without the Sentry plugin", () => {
		const adapter = fakeAdapter(false);
		handleTaskError(adapter, "Forecast refresh", "plain string");
		assert.deepStrictEqual(adapter.logs, [{ level: "warn", msg: "Forecast refresh failed: plain string" }]);
	});

	it("runSafely catches a rejected task instead of leaving an unhandled rejection", async () => {
		const adapter = fakeAdapter();
		runSafely(adapter, "History refresh", () => Promise.reject(new Error("rejected")));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(adapter.logs, [{ level: "warn", msg: "History refresh failed: rejected" }]);
	});

	it("runSafely also catches a task that throws synchronously", async () => {
		const adapter = fakeAdapter();
		runSafely(adapter, "Stale check", () => {
			throw new Error("sync");
		});
		await new Promise(resolve => setImmediate(resolve));
		assert.deepStrictEqual(adapter.logs, [{ level: "warn", msg: "Stale check failed: sync" }]);
	});
});
