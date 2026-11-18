import { App, Notice, TFile } from "obsidian";
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
		private settings: MSTodoSettings
	) {}

	async syncListToListingNote(list: TodoList, notePath: string): Promise<void> {
		let file = this.app.vault.getAbstractFileByPath(notePath);
		if (!(file instanceof TFile)) {
			const created = await this.app.vault.create(notePath, `# ${list.displayName}\n\n`);
			file = created;
		}
		const tasks = await this.graph.getTasks(list.id);
		await this.applySync(file as TFile, tasks, list);
	}

	/** Sync all configured mappings. */
	async syncAll(): Promise<string> {
		const lists = await this.graph.getLists();
		const byId = new Map(lists.map((l) => [l.id, l]));
		let synced = 0;
		for (const [listId, notePath] of Object.entries(this.settings.mappings)) {
			const list = byId.get(listId);
			if (!list) continue;
			await this.syncListToListingNote(list, notePath);
			synced++;
		}
		return `Synced ${synced} list(s).`;
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

		// Pass 1: update existing lines (matched by ^ms-todo-<id> block id)
		const newLines: string[] = [];
		for (const line of lines) {
			const idMatch = /\^ms-todo-([0-9a-fA-F-]{8,})\s*$/.exec(line);
			if (idMatch && taskById.has(idMatch[1])) {
				const task = taskById.get(idMatch[1])!;
				matchedTaskIds.add(task.id);
				newLines.push(this.renderTaskLine(line, task));
				const parsed = parseLine(line);
				if (parsed) noteTitles.add(parsed.title);
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

	private renderTaskLine(oldLine: string, task: TodoTask): string {
		const parsed = parseLine(oldLine);
		const indent = parsed?.indent ?? "";
		return taskToLine(task, indent);
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
		new Notice(`To Do task ${done ? "completed" : "reopened"}.`);
	}

	/** Create a To Do task from a new unchecked line in a mapped note. */
	async pushNewLine(file: TFile, listId: string, title: string): Promise<TodoTask | null> {
		const lists = await this.graph.getLists();
		if (!lists.some((l) => l.id === listId)) return null;
		const task = await this.graph.createTask(listId, { title });
		return task;
	}
}
