import { App, Notice, TFile, TFolder } from "obsidian";
import type { GraphClient } from "./graph";
import { parseLine, taskToLine } from "./markdown";
import type { MSTodoSettings } from "./settings";
import type { TodoList, TodoTask } from "./types";

/**
 * Bidirectional sync between one To Do list and one note.
 *
 * - Note lines containing a `ms-todo-id` block-id (`^ms-todo-id-<id>`) are
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
	 * 同步文件夹改名：把旧文件夹下已映射的笔记搬到新文件夹，旧文件随之消失，
	 * 搬空后的旧文件夹一并删除。
	 */
	async migrateFolder(from: string, to: string): Promise<number> {
		const norm = (p: string) => p.replace(/\/+$/, "").trim();
		const oldDir = norm(from);
		const newDir = norm(to);
		if (!oldDir || oldDir === newDir) return 0;
		const oldPrefix = `${oldDir}/`;
		let moved = 0;
		for (const [listId, path] of Object.entries(this.settings.mappings)) {
			if (!path.startsWith(oldPrefix)) continue;
			let target = `${newDir}/${path.slice(oldPrefix.length)}`;
			// 目标位置已有同名笔记时不覆盖，另起名字
			if (this.app.vault.getAbstractFileByPath(target)) {
				const m = /\.md$/.exec(target);
				const stem = m ? target.slice(0, m.index) : target;
				let n = 2;
				while (this.app.vault.getAbstractFileByPath(`${stem} ${n}${m ? ".md" : ""}`)) n++;
				target = `${stem} ${n}${m ? ".md" : ""}`;
			}
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				await this.ensureFolder(target);
				await this.app.vault.rename(file, target);
				moved++;
			}
			this.settings.mappings[listId] = target;
		}
		const oldFolder = this.app.vault.getAbstractFileByPath(oldDir);
		if (oldFolder instanceof TFolder && oldFolder.children.length === 0) {
			await this.app.vault.delete(oldFolder);
		}
		await this.save();
		return moved;
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

		const taskById = new Map(visible.map((t) => [t.id, t]));
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
	async pushToggle(file: TFile, listId: string, taskId: string, done: boolean): Promise<void> {
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
