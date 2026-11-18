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
const { taskToLine, parseLine, toGraphDate, blockIdFor, diffToggles } = mod.exports;

// roundtrip
const task = {
	id: "abc12345-1234",
	title: "Buy milk",
	status: "notStarted",
	importance: "normal",
	dueDateTime: { dateTime: "2026-11-20T00:00:00.000", timeZone: "UTC" },
	body: { content: "from store", contentType: "text" },
};
const token = blockIdFor(task.id);
assert.match(token, /^ms-todo-[0-9a-f]{16}$/, "block id is Obsidian-safe (letters/digits/dashes only)");
assert.strictEqual(blockIdFor(task.id), token, "block id is deterministic");
assert.notStrictEqual(blockIdFor("other-task-id"), token, "different tasks get different ids");
const base64Id = "AAMkAGI2THVSAAA=_+x/y==";
assert.match(blockIdFor(base64Id), /^ms-todo-[0-9a-f]{16}$/, "base64 task ids are hashed, never inlined");
const line = taskToLine(task);
assert.strictEqual(line, `- [ ] Buy milk 📅 2026-11-20 💭 from store ^${token}`, "unchecked line with block id");
assert.strictEqual(taskToLine(task, "", false), "- [ ] Buy milk 📅 2026-11-20 💭 from store", "id can be omitted");
const parsed = parseLine(line);
assert.deepStrictEqual(parsed, { title: "Buy milk", done: false, indent: "", taskId: token.replace("ms-todo-", "") }, "parse unchecked + id");
assert.strictEqual(parseLine("- [ ] no id line").taskId, undefined, "line without id");

const doneTask = { ...task, status: "completed" };
const doneLine = taskToLine(doneTask);
assert.strictEqual(doneLine, `- [x] Buy milk 📅 2026-11-20 💭 from store ^${token}`, "checked line");

// 旧格式（整条 base64 taskId）仍能被解析，供迁移使用
const legacy = parseLine("- [ ] 旧任务 ^ms-todo-AAMkAGI2THVSAAA=");
assert.strictEqual(legacy.title, "旧任务", "legacy id stripped from title");
assert.strictEqual(legacy.taskId, "AAMkAGI2THVSAAA=", "legacy id parsed");
const parsedDone = parseLine(doneLine);
assert.strictEqual(parsedDone.done, true, "parse checked");
assert.strictEqual(parsedDone.title, "Buy milk", "id stripped from title");

// indented line keeps indent
const ind = taskToLine(task, "\t");
assert.strictEqual(parseLine(ind).indent, "\t", "indent preserved");

// non-task lines rejected
assert.strictEqual(parseLine("- plain bullet"), null);
assert.strictEqual(parseLine("regular text"), null);

// 重排（已完成沉底）不应被误判成勾选变化
const beforeSort = "# 工作\n\n- [x] A ^ms-todo-aaaaaaaaaaaaaaaa\n- [ ] B ^ms-todo-bbbbbbbbbbbbbbbb\n";
const afterSort = "# 工作\n\n- [ ] B ^ms-todo-bbbbbbbbbbbbbbbb\n- [x] A ^ms-todo-aaaaaaaaaaaaaaaa\n";
assert.deepStrictEqual(diffToggles(beforeSort, afterSort), [], "reordering is not a toggle");

// 真勾选能识别，且只报变化的那条
assert.deepStrictEqual(
	diffToggles("- [ ] A ^ms-todo-aaaaaaaaaaaaaaaa", "- [x] A ^ms-todo-aaaaaaaaaaaaaaaa"),
	[{ taskId: "aaaaaaaaaaaaaaaa", done: true }],
	"real toggle detected"
);
assert.deepStrictEqual(
	diffToggles("- [ ] A ^ms-todo-aaaaaaaaaaaaaaaa", "- [ ] A ^ms-todo-aaaaaaaaaaaaaaaa\n- [ ] C"),
	[],
	"new untagged line is not a toggle"
);

// graph date
assert.deepStrictEqual(toGraphDate("2026-11-20"), { dateTime: "2026-11-20T00:00:00.000", timeZone: "UTC" });

console.log("all markdown tests passed");
