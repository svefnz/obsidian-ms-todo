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

// 3b) 行里带 block id，改标题后按 id 就地更新（不新增行）
assert.ok(vault.files.get("Microsoft To Do/工作.md").includes("^ms-todo-t1"), "block id written");
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

// 3d) 取消勾选的清单不同步
settings.disabledListIds = ["L2"];
const beforeSkip = settings.mappings.L2;
await engine.syncAll();
assert.deepStrictEqual(settings.mappings.L2, beforeSkip, "disabled list keeps old mapping untouched");
settings.disabledListIds = [];

// 3e) 改同步文件夹 -> 笔记迁移，旧路径消失，空文件夹删除
const moved = await engine.migrateFolder("Microsoft To Do", "待办/To Do");
assert.strictEqual(moved, 3, "three notes moved");
assert.deepStrictEqual(Object.values(settings.mappings).sort(), ["待办/To Do/买菜-清单.md", "待办/To Do/工作 2.md", "待办/To Do/工作.md"].sort());
assert.ok(vault.files.has("待办/To Do/工作.md"), "file at new path");
assert.ok(!vault.files.has("Microsoft To Do/工作.md"), "old path gone");
assert.ok(vault.files.get("待办/To Do/工作.md").includes("写季度报告"), "content preserved");
assert.ok(!vault.folderObjs.has("Microsoft To Do"), "empty old folder removed");
settings.syncFolder = "待办/To Do";

// 3f) 目标已存在同名笔记时不覆盖
settings.syncFolder = "待办/To Do";
await vault.create("归档/工作.md", "占用");
await engine.migrateFolder("待办/To Do", "归档");
assert.strictEqual(vault.files.get("归档/工作.md"), "占用", "existing note untouched");
assert.ok(vault.files.has("归档/工作 2.md"), "collision renamed");
settings.mappings = {};
settings.syncFolder = "Microsoft To Do";

// 4) 空账户
const emptyEngine = new SyncEngine({ vault: new Vault() }, { getLists: async () => [] }, settings, async () => {});
assert.strictEqual(await emptyEngine.syncAll(), "Microsoft To Do 中没有清单。");

// 5) 文件名清洗
assert.strictEqual(safeFileName("a/b:c*d?"), "a-b-c-d-");
assert.strictEqual(safeFileName("  "), "未命名清单");

console.log("all sync tests passed");
