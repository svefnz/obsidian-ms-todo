// Assert-based self-check for the pure task<->markdown mapping logic.
// Run: node tests/markdown.test.mjs  (imports the esbuild-built CJS? no — rebuild a tiny bundle)
import { buildSync } from "esbuild";
import assert from "node:assert";
import { createRequire } from "node:module";

const ctx = await buildSync({
	entryPoints: ["tests/entry.ts"],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	external: ["obsidian"],
});

const mod = { exports: {} };
await (async () => {
	const run = new Function("module", "exports", "require", ctx.outputFiles[0].text);
	run(mod, mod.exports, createRequire(import.meta.url));
})();
const { taskToLine, parseLine, toGraphDate } = mod.exports;

// roundtrip
const task = {
	id: "abc12345-1234",
	title: "Buy milk",
	status: "notStarted",
	importance: "normal",
	dueDateTime: { dateTime: "2026-11-20T00:00:00.000", timeZone: "UTC" },
	body: { content: "from store", contentType: "text" },
};
const line = taskToLine(task);
assert.strictEqual(line, "- [ ] Buy milk 📅 2026-11-20 💭 from store ^ms-todo-abc12345-1234", "unchecked line with block id");
assert.strictEqual(taskToLine(task, "", false), "- [ ] Buy milk 📅 2026-11-20 💭 from store", "id can be omitted");
const parsed = parseLine(line);
assert.deepStrictEqual(parsed, { title: "Buy milk", done: false, indent: "", taskId: "abc12345-1234" }, "parse unchecked + id");
assert.strictEqual(parseLine("- [ ] no id line").taskId, undefined, "line without id");

const doneTask = { ...task, status: "completed" };
const doneLine = taskToLine(doneTask);
assert.strictEqual(doneLine, "- [x] Buy milk 📅 2026-11-20 💭 from store ^ms-todo-abc12345-1234", "checked line");
const parsedDone = parseLine(doneLine);
assert.strictEqual(parsedDone.done, true, "parse checked");
assert.strictEqual(parsedDone.title, "Buy milk", "id stripped from title");

// indented line keeps indent
const ind = taskToLine(task, "\t");
assert.strictEqual(parseLine(ind).indent, "\t", "indent preserved");

// non-task lines rejected
assert.strictEqual(parseLine("- plain bullet"), null);
assert.strictEqual(parseLine("regular text"), null);

// graph date
assert.deepStrictEqual(toGraphDate("2026-11-20"), { dateTime: "2026-11-20T00:00:00.000", timeZone: "UTC" });

console.log("all markdown tests passed");
