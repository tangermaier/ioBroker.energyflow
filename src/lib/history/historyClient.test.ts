import assert from "node:assert";
import { normalizeHourlyHistory, queryHourlyActual, type HistoryMessenger, type HistorySource } from "./historyClient.js";

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 10, 1, 0, 0, 0); // hour-aligned

describe("historyClient", () => {
	describe("normalizeHourlyHistory", () => {
		it("maps bucket-middle timestamps (@iobroker/aggregate, influxdb 2 mean) to the hour end", () => {
			const r = normalizeHourlyHistory(
				[
					{ ts: T0 + H / 2, val: 100 },
					{ ts: T0 + H + H / 2, val: 200 },
				],
				T0,
				T0 + 2 * H,
			);
			assert.deepStrictEqual(r, [
				{ ts: T0 + H, powerW: 100 },
				{ ts: T0 + 2 * H, powerW: 200 },
			]);
		});

		it("maps bucket-start timestamps (influxdb 1 GROUP BY time) to the hour end", () => {
			const r = normalizeHourlyHistory([{ ts: T0, val: 5 }], T0, T0 + H);
			assert.deepStrictEqual(r, [{ ts: T0 + H, powerW: 5 }]);
		});

		it("maps a max sample's own time (influxdb 2 max) to its hour end", () => {
			const r = normalizeHourlyHistory([{ ts: T0 + 59 * 60 * 1000, val: 98 }], T0, T0 + H);
			assert.deepStrictEqual(r, [{ ts: T0 + H, powerW: 98 }]);
		});

		it("drops border buckets, nulls and non-numbers", () => {
			const r = normalizeHourlyHistory(
				[
					{ ts: T0 - H / 2, val: 1 }, // before start
					{ ts: T0 + H / 2, val: null },
					{ ts: T0 + H + H / 2, val: "x" },
					{ ts: T0 + 2 * H + H / 2, val: 7 },
					{ ts: T0 + 3 * H + H / 2, val: 9 }, // at/after end
				],
				T0,
				T0 + 3 * H,
			);
			assert.deepStrictEqual(r, [{ ts: T0 + 3 * H, powerW: 7 }]);
		});

		it("keeps a partial last hour (end not aligned)", () => {
			const r = normalizeHourlyHistory([{ ts: T0 + H + 10 * 60 * 1000, val: 3 }], T0, T0 + H + 20 * 60 * 1000);
			assert.deepStrictEqual(r, [{ ts: T0 + 2 * H, powerW: 3 }]);
		});

		it("keeps the first value if an hour is returned twice", () => {
			const r = normalizeHourlyHistory(
				[
					{ ts: T0 + 10, val: 1 },
					{ ts: T0 + 20, val: 2 },
				],
				T0,
				T0 + H,
			);
			assert.deepStrictEqual(r, [{ ts: T0 + H, powerW: 1 }]);
		});
	});

	describe("queryHourlyActual", () => {
		function source(answer: unknown, calls: unknown[] = []): HistorySource {
			const messenger: HistoryMessenger = {
				sendToAsync: (instance, command, message) => {
					calls.push({ instance, command, message });
					return Promise.resolve(answer as ioBroker.Message);
				},
			};
			return { instance: "history.0", messenger };
		}

		it("sends an hour-aligned getHistory request with step 1 h and normalizes the answer", async () => {
			const calls: { instance: string; command: string; message: { id: string; options: Record<string, unknown> } }[] = [];
			const src = source({ result: [{ ts: T0 + H / 2, val: 42 }] }, calls);
			const r = await queryHourlyActual(src, "a.b.c", new Date(T0 + 17 * 60 * 1000), new Date(T0 + 2 * H), "max");
			assert.deepStrictEqual(r, [{ ts: T0 + H, powerW: 42 }]);
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].instance, "history.0");
			assert.strictEqual(calls[0].command, "getHistory");
			assert.strictEqual(calls[0].message.id, "a.b.c");
			assert.strictEqual(calls[0].message.options.start, T0);
			assert.strictEqual(calls[0].message.options.step, H);
			assert.strictEqual(calls[0].message.options.aggregate, "max");
			assert.strictEqual(calls[0].message.options.removeBorderValues, true);
		});

		it("throws on an error answer", async () => {
			await assert.rejects(queryHourlyActual(source({ error: "boom" }), "x", new Date(T0), new Date(T0 + H)), /boom/);
		});

		it("returns nothing when no history source is configured", async () => {
			const src: HistorySource = { instance: "", messenger: { sendToAsync: () => Promise.reject(new Error("must not be called")) } };
			assert.deepStrictEqual(await queryHourlyActual(src, "x", new Date(T0), new Date(T0 + H)), []);
		});
	});
});
