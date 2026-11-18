import { build } from "esbuild";
import assert from "node:assert";
import { createRequire } from "node:module";

const out = await build({
	entryPoints: ["tests/entry-sync.ts"],
	bundle: true,
	write: false,
	format: "cjs",
	platform: "node",
	plugins: [{
		name: "stub-obsidian",
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: new URL("./obsidian-stub.ts", import.meta.url).pathname }));
		},
	}],
});

const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
const { SyncEngine, safeFileName } = mod.exports;
const { TFile, TFolder } = mod.exports;

class Vault {
	constructor() {
		this.files = new Map();
		this.folders = new Set();
		this.folderObjs = new Map();
	}
	syncFolderChildren() {
		for (const [p, f] of this.folderObjs) {
			f.children = [...this.files.keys()].filter((k) => k.startsWith(`${p}/`));
		}
	}
	async rename(file, newPath) {
		if (!this.files.has(file.path)) throw new Error(`no file ${file.path}`);
		const content = this.files.get(file.path);
		this.files.delete(file.path);
		this.files.set(newPath, content);
		this.syncFolderChildren();
		return new TFile(newPath);
	}
	async delete(target) {
		if (target instanceof TFolder) {
			this.folders.delete(target.path);
			this.folderObjs.delete(target.path);
			return;
		}
		this.files.delete(target.path);
		this.syncFolderChildren();
	}
	getAbstractFileByPath(p) {
		if (this.files.has(p)) return new TFile(p);
		if (this.folderObjs.has(p)) return this.folderObjs.get(p);
		return null;
	}
	async create(p, content) {
		if (this.files.has(p)) throw new Error(`already exists: ${p}`);
		this.files.set(p, content);
		this.syncFolderChildren();
		return new TFile(p);
	}
	async modify(f, content) {
		this.files.set(f.path, content);
	}
	async read(f) {
		return this.files.get(f.path);
	}
	async createFolder(p) {
		this.folders.add(p);
		this.folderObjs.set(p, new TFolder(p));
	}
}

const graph = {
	lists: [
		{ id: "L1", displayName: "工作" },
		{ id: "L2", displayName: "买菜/清单" },
		{ id: "L3", displayName: "工作" },
	],
	tasks: {
		L1: [{ id: "t1", title: "写报告", status: "notStarted", dueDateTime: { dateTime: "2026-01-05T00:00:00.000", timeZone: "UTC" } }],
		L2: [{ id: "t2", title: "牛奶", status: "notStarted" }],
		L3: [],
	},
	async getLists() {
		return this.lists;
	},
	async getTasks(id) {
		return this.tasks[id] ?? [];
	},
};

const settings = { mappings: {}, disabledListIds: [], syncFolder: "Microsoft To Do", hideCompleted: false };
const vault = new Vault();
let saves = 0;
const engine = new SyncEngine({ vault }, graph, settings, async () => { saves++; });

// 1) 全新安装：没有映射也能同步全部清单，并自动建立映射
const msg = await engine.syncAll();
assert.strictEqual(msg, "已同步 3 个清单。");
assert.strictEqual(saves, 1, "mappings persisted once");
assert.deepStrictEqual(settings.mappings, {
	L1: "Microsoft To Do/工作.md",
	L2: "Microsoft To Do/买菜-清单.md",
	L3: "Microsoft To Do/工作 2.md",
});
assert.ok(vault.folders.has("Microsoft To Do"), "folder created");
const work = vault.files.get("Microsoft To Do/工作.md");
assert.ok(work.includes("# 工作"), "note title");
assert.ok(work.includes("写报告"), "task appended");

// 2) 再跑一次：沿用已有映射，不重复建笔记、不重复保存
const before = new Map(vault.files);
const msg2 = await engine.syncAll();
assert.strictEqual(msg2, "已同步 3 个清单。");
assert.strictEqual(saves, 1, "no extra save when mappings exist");
assert.deepStrictEqual([...vault.files.keys()].sort(), [...before.keys()].sort(), "no duplicate notes");

// 3) 幂等：任务不会因为重复同步而重复追加
assert.strictEqual(vault.files.get("Microsoft To Do/工作.md").split("写报告").length - 1, 1, "no duplicate task line");

// 3b) 行里带 block id（合法字符），改标题后按 id 就地更新（不新增行）
const workNote = () => vault.files.get("Microsoft To Do/工作.md");
assert.match(workNote(), / \^ms-todo-[0-9a-f]{16}$/m, "block id written in Obsidian-safe form");

// 3a3) 认不出来源的旧格式 id（任务已删/已改）会被摘掉，避免阅读视图里露出来
const goodNote = workNote();
vault.files.set("Microsoft To Do/工作.md", "# 工作\n- [ ] 写报告 📅 2026-01-05 ^ms-todo-AAMkAGI2THVSAAA=\n");
await engine.syncAll();
assert.ok(!workNote().includes("^ms-todo-AAMkAGI2THVSAAA="), "dangling legacy id removed");
assert.ok(workNote().includes("写报告"), "line text kept");
vault.files.set("Microsoft To Do/工作.md", goodNote); // 复原，后续用例依赖这行
await engine.syncAll();

// 3a2) 旧格式（完整 base64 taskId）的笔记行仍能匹配，并被重写成新格式
const legacyNote = workNote().replace(/ \^ms-todo-[0-9a-f]{16}$/m, " ^ms-todo-t1");
vault.files.set("Microsoft To Do/工作.md", legacyNote);
await engine.syncAll();
assert.match(workNote(), / \^ms-todo-[0-9a-f]{16}$/m, "legacy id migrated to short form");
assert.strictEqual(workNote().split("写报告").length - 1, 1, "legacy match did not duplicate the line");
graph.tasks.L1 = [{ ...graph.tasks.L1[0], title: "写季度报告" }];
await engine.syncAll();
const afterRename = vault.files.get("Microsoft To Do/工作.md");
assert.ok(afterRename.includes("写季度报告"), "title updated in place");
assert.ok(!afterRename.includes("- [ ] 写报告"), "old title gone");
assert.ok(!afterRename.includes("写报告\n") || afterRename.includes("写季度报告"), "no stale line");

// 3c) To Do 侧勾选完成后同步到笔记
graph.tasks.L1 = [{ ...graph.tasks.L1[0], status: "completed" }];
await engine.syncAll();
assert.ok(vault.files.get("Microsoft To Do/工作.md").includes("- [x] 写季度报告"), "completion synced");

// 3c2) 已完成任务自动沉到末尾
graph.tasks.L1 = [
	{ id: "t1", title: "写季度报告", status: "completed" },
	{ id: "t9", title: "新任务", status: "notStarted" },
];
await engine.syncAll();
{
	const lines = vault.files.get("Microsoft To Do/工作.md").split("\n").filter((l) => l.startsWith("- ["));
	assert.deepStrictEqual(lines.map((l) => (l.startsWith("- [x]") ? "done" : "open")), ["open", "done"], "completed sunk to the end");
	assert.strictEqual(lines[0].includes("新任务"), true, "open task first");
}
await engine.syncAll(); // 幂等：再跑一次顺序不变
{
	const lines = vault.files.get("Microsoft To Do/工作.md").split("\n").filter((l) => l.startsWith("- ["));
	assert.deepStrictEqual(lines.map((l) => (l.startsWith("- [x]") ? "done" : "open")), ["open", "done"], "ordering is idempotent");
}
settings.sortCompletedLast = false;
await engine.syncAll();
settings.sortCompletedLast = true;

// 3d) 取消勾选的清单不同步
settings.disabledListIds = ["L2"];
const beforeSkip = settings.mappings.L2;
await engine.syncAll();
assert.deepStrictEqual(settings.mappings.L2, beforeSkip, "disabled list keeps old mapping untouched");
settings.disabledListIds = [];

// 3e) 改同步文件夹 -> 笔记迁移，旧路径消失，空文件夹删除
const { moved, missing } = await engine.migrateInto("待办/To Do");
assert.strictEqual(moved, 3, "three notes moved");
assert.deepStrictEqual(missing, [], "nothing missing");
assert.deepStrictEqual(Object.values(settings.mappings).sort(), ["待办/To Do/买菜-清单.md", "待办/To Do/工作 2.md", "待办/To Do/工作.md"].sort());
assert.ok(vault.files.has("待办/To Do/工作.md"), "file at new path");
assert.ok(!vault.files.has("Microsoft To Do/工作.md"), "old path gone");
assert.ok(vault.files.get("待办/To Do/工作.md").includes("写季度报告"), "content preserved");
assert.ok(!vault.folderObjs.has("Microsoft To Do"), "empty old folder removed");
settings.syncFolder = "待办/To Do";

// 3f) 目标已存在同名笔记时不覆盖
settings.syncFolder = "待办/To Do";
await vault.create("归档/工作.md", "占用");
await engine.migrateInto("归档");
assert.strictEqual(vault.files.get("归档/工作.md"), "占用", "existing note untouched");
assert.ok(
	["归档/工作 2.md", "归档/工作 3.md", "归档/工作 4.md"].some((p) => vault.files.has(p)),
	"collision renamed"
);
// 3g) 迁移可重复执行：再跑一次不搬任何东西
const noop = await engine.migrateInto("归档");
assert.strictEqual(noop.moved, 0, "second run is a no-op");
assert.strictEqual(noop.missing.length, 0);

// 3h) 映射指向的文件不存在时报告 missing，不产生新映射
settings.mappings = { L1: "不存在/工作.md" };
const ghost = await engine.migrateInto("新文件夹");
assert.strictEqual(ghost.moved, 0);
assert.deepStrictEqual(ghost.missing, ["不存在/工作.md"]);
assert.deepStrictEqual(settings.mappings, { L1: "不存在/工作.md" }, "mapping untouched when file is gone");

// 3i) 关闭清单同步时立刻删除笔记（进系统废纸篓）并清掉映射
settings.mappings = { L1: "Microsoft To Do/工作.md" };
vault.files.set("Microsoft To Do/工作.md", "# 工作\n");
let trashed = null;
vault.trash = async (f) => {
	trashed = f.path;
	vault.files.delete(f.path);
};
const gonePath = await engine.removeListNote("L1");
assert.strictEqual(gonePath, "Microsoft To Do/工作.md", "returns deleted path");
assert.strictEqual(trashed, "Microsoft To Do/工作.md", "goes through system trash");
assert.ok(!vault.files.has("Microsoft To Do/工作.md"), "note file gone");
assert.deepStrictEqual(settings.mappings, {}, "mapping dropped");
assert.strictEqual(await engine.removeListNote("NOPE"), null, "unknown list is a no-op");

// 无 vault.trash 的宿主上退回直接删除
delete vault.trash;
settings.mappings = { L2: "Microsoft To Do/买菜-清单.md" };
vault.files.set("Microsoft To Do/买菜-清单.md", "# 买菜\n");
await engine.removeListNote("L2");
assert.ok(!vault.files.has("Microsoft To Do/买菜-清单.md"), "fallback hard delete");

settings.mappings = {};
settings.syncFolder = "Microsoft To Do";

// 4) 空账户
const emptyEngine = new SyncEngine({ vault: new Vault() }, { getLists: async () => [] }, settings, async () => {});
assert.strictEqual(await emptyEngine.syncAll(), "Microsoft To Do 中没有清单。");

// 5) 文件名清洗
assert.strictEqual(safeFileName("a/b:c*d?"), "a-b-c-d-");
assert.strictEqual(safeFileName("  "), "未命名清单");

console.log("all sync tests passed");
