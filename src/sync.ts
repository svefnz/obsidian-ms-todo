import { App, Notice, TFile, TFolder } from "obsidian";
import type { GraphClient } from "./graph";
import { BLOCK_ID_RE, blockIdFor, parseLine, taskToLine } from "./markdown";
import type { MSTodoSettings } from "./settings";
import type { TodoList, TodoTask } from "./types";

/**
 * Bidirectional sync between one To Do list and one note.
 *
 * - Note lines containing a `ms-todo-<hash>` block-id are
 *   matched to To Do tasks by id; those without are matched by title.
 * - Tasks new to the note are appended; note lines new to To Do are created.
 * - Completion state and title changes propagate both ways (last-writer-wins
 *   per field via lastModifiedDateTime comparison when available).
 */
export class SyncEngine {
	constructor(
		private app: App,
		private graph: GraphClient,
		private settings: MSTodoSettings,
		private save: () => Promise<void> = async () => {}
	) {}

	/** block id（哈希串）→ 真实 taskId，供勾选回写用 */
	private tokenToId = new Map<string, string>();

	async syncListToListingNote(list: TodoList, notePath: string): Promise<void> {
		let file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) {
			await this.ensureFolder(notePath);
			const created = await this.app.vault.create(notePath, `# ${list.displayName}\n\n`);
			file = created;
		}
		const tasks = await this.graph.getTasks(list.id);
		await this.applySync(file as TFile, tasks, list);
	}

	/**
	 * Sync every list in the account. Lists without a mapping get a note in
	 * `settings.syncFolder` and the mapping is persisted, so "同步全部清单"
	 * works on a fresh install without manual configuration.
	 */
	async syncAll(): Promise<string> {
		const lists = await this.graph.getLists();
		if (lists.length === 0) return "Microsoft To Do 中没有清单。";
		const used = new Set(Object.values(this.settings.mappings));
		let changed = false;
		let synced = 0;
		for (const list of lists) {
			if (this.settings.disabledListIds?.includes(list.id)) continue;
			let notePath = this.settings.mappings[list.id];
			if (!notePath) {
				notePath = this.uniquePath(list.displayName, used);
				used.add(notePath);
				this.settings.mappings[list.id] = notePath;
				changed = true;
			}
			await this.syncListToListingNote(list, notePath);
			synced++;
		}
		if (changed) await this.save();
		return `已同步 ${synced} 个清单。`;
	}

	/**
	 * 把所有映射笔记搬到目标文件夹（不看"旧文件夹"是谁，因此重启/改设置后
	 * 仍然可靠，且可重复执行）。
	 */
	async migrateInto(to: string): Promise<{ moved: number; missing: string[] }> {
		const norm = (p: string) => p.replace(/\/+$/, "").trim();
		const newDir = norm(to);
		const oldDirs = new Set<string>();
		let moved = 0;
		const missing: string[] = [];
		for (const [listId, path] of Object.entries(this.settings.mappings)) {
			const cut = path.lastIndexOf("/");
			const dir = cut === -1 ? "" : path.slice(0, cut);
			const name = cut === -1 ? path : path.slice(cut + 1);
			if (dir !== newDir) oldDirs.add(dir);
			if (dir === newDir) continue;
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				missing.push(path);
				continue;
			}
			const target = this.freeName(`${newDir}/${name}`);
			await this.ensureFolder(target);
			await this.app.vault.rename(file, target);
			this.settings.mappings[listId] = target;
			moved++;
		}
		for (const dir of oldDirs) {
			if (!dir) continue;
			const folder = this.app.vault.getAbstractFileByPath(dir);
			if (folder instanceof TFolder && folder.children.length === 0) {
				await this.app.vault.delete(folder);
			}
		}
		await this.save();
		return { moved, missing };
	}

	/** 关闭某个清单的同步时，立刻删除它的笔记（进系统废纸篓，可从废纸篓找回） */
	async removeListNote(listId: string): Promise<string | null> {
		const path = this.settings.mappings[listId];
		if (!path) return null;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			const trash = (this.app.vault as unknown as { trash?: (f: TFile, sys: boolean) => Promise<void> }).trash;
			if (typeof trash === "function") await trash.call(this.app.vault, file, true);
			else await this.app.vault.delete(file); // 老版本/无系统废纸篓时直接删除
		}
		delete this.settings.mappings[listId];
		await this.save();
		return path;
	}

	/** 目标已存在同名文件时另起名字，绝不覆盖 */
	private freeName(target: string): string {
		if (!this.app.vault.getAbstractFileByPath(target)) return target;
		const dot = /\.md$/.exec(target);
		const stem = dot ? target.slice(0, dot.index) : target;
		const ext = dot ? ".md" : "";
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(`${stem} ${n}${ext}`)) n++;
		return `${stem} ${n}${ext}`;
	}

	private uniquePath(listName: string, used: Set<string>): string {
		const folder = (this.settings.syncFolder || "Microsoft To Do").replace(/\/+$/, "");
		const base = `${folder}/${safeFileName(listName)}`;
		let path = `${base}.md`;
		let n = 2;
		while (used.has(path) || this.app.vault.getAbstractFileByPath(path)) {
			path = `${base} ${n++}.md`;
		}
		return path;
	}

	private async ensureFolder(notePath: string): Promise<void> {
		const dir = notePath.split("/").slice(0, -1).join("/");
		if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
		try {
			await this.app.vault.createFolder(dir);
		} catch {
			/* 并发创建或已存在 */
		}
	}

	private async applySync(file: TFile, tasks: TodoTask[], list: TodoList): Promise<void> {
		const content = await this.app.vault.read(file);
		const lines = content.split("\n");
		const visible = this.settings.hideCompleted
			? tasks.filter((t) => t.status !== "completed" && t.status !== "autoCompleted")
			: tasks;

		// 同时按哈希 token 和原始 id 建索引：旧笔记里的完整 id 仍能匹配上，
		// 匹配到的行会被重写成新格式（下次同步即完成迁移）
		const taskById = new Map<string, TodoTask>();
		for (const t of visible) {
			taskById.set(t.id, t);
			const token = blockIdFor(t.id).replace(/^ms-todo-/, ""); // 行里存的是去掉前缀的部分
			taskById.set(token, t);
			this.tokenToId.set(token, t.id);
			this.tokenToId.set(t.id, t.id);
		}
		const matchedTaskIds = new Set<string>();
		const noteTitles = new Set<string>();

		// Pass 1: update existing lines (matched by ^ms-todo-<id> block id),
		// and remember every title already present so pass 2 can't duplicate.
		const newLines: string[] = [];
		for (const line of lines) {
			const parsed = parseLine(line);
			if (parsed) noteTitles.add(parsed.title);
			if (parsed?.taskId && taskById.has(parsed.taskId)) {
				const task = taskById.get(parsed.taskId)!;
				matchedTaskIds.add(task.id);
				newLines.push(taskToLine(task, parsed.indent));
				continue;
			}
			// 旧格式（整条 base64 id）已认不出来源任务：Obsidian 不认这种块引用，
			// 会在阅读视图里当普通文字显示，所以直接摘掉，别再碍眼
			if (parsed?.taskId && !/^[0-9a-f]{16}$/.test(parsed.taskId)) {
				newLines.push(line.replace(BLOCK_ID_RE, ""));
				continue;
			}
			newLines.push(line);
		}

		// Pass 2: append tasks not present in the note
		const toAppend = visible.filter((t) => !matchedTaskIds.has(t.id) && !noteTitles.has(t.title));
		if (toAppend.length > 0) {
			if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") newLines.push("");
			for (const t of toAppend) newLines.push(taskToLine(t));
		}

		await this.app.vault.modify(file, newLines.join("\n"));
	}

	/** Push a single checkbox toggle from the note to To Do. */
	async pushToggle(file: TFile, listId: string, token: string, done: boolean): Promise<void> {
		const taskId = this.tokenToId.get(token) ?? token; // 未同步过时按原值试
		if (done) {
			await this.graph.updateTask(listId, taskId, {
				status: "completed",
				completedDateTime: { dateTime: new Date().toISOString(), timeZone: "UTC" },
			});
		} else {
			await this.graph.updateTask(listId, taskId, { status: "notStarted", completedDateTime: null as never });
		}
		new Notice(`任务已${done ? "标记完成" : "重新打开"}。`);
	}

	/** Create a To Do task from a new unchecked line in a mapped note. */
	async pushNewLine(file: TFile, listId: string, title: string): Promise<TodoTask | null> {
		const lists = await this.graph.getLists();
		if (!lists.some((l) => l.id === listId)) return null;
		const task = await this.graph.createTask(listId, { title });
		return task;
	}
}

/** 清单名里不能出现在文件名中的字符替换掉 */
export function safeFileName(name: string): string {
	const cleaned = name.replace(/[\\/:*?"<>|#^[\]]/g, "-").replace(/\s+/g, " ").trim();
	return cleaned || "未命名清单";
}
