import type { TodoTask } from "./types";
/** Map a TodoTask to the metadata we embed in the note. */
export function taskToMetadata(task: TodoTask): Record<string, string> {
	const meta: Record<string, string> = { "ms-todo-id": task.id, "ms-todo-list": "" };
	if (task.dueDateTime) meta["ms-todo-due"] = task.dueDateTime.dateTime.slice(0, 10);
	if (task.body?.content) meta["ms-todo-note"] = task.body.content;
	return meta;
}

/**
 * Obsidian block ids may only contain letters, digits and dashes, and To Do's
 * task ids are base64 (with `=`, `+`, `/`, `_`) — embedding them verbatim made
 * the id render as plain text in reading view. So we hash to a stable,
 * block-id-safe 16-hex token.
 */
export function blockIdFor(taskId: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x01000193;
	for (let i = 0; i < taskId.length; i++) {
		const c = taskId.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
		h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
	}
	return `ms-todo-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/**
 * Build a checkbox line for a task.
 * The trailing `^ms-todo-<hash>` block id is what lets later syncs match the
 * line to the task by id instead of by title (titles get renamed).
 */
export function taskToLine(task: TodoTask, indent = "", withId = true): string {
	const done = task.status === "completed" || task.status === "autoCompleted";
	const parts: string[] = [indent, done ? "- [x] " : "- [ ] ", task.title];
	if (task.dueDateTime) parts.push(" 📅 ", task.dueDateTime.dateTime.slice(0, 10));
	if (task.body?.content) parts.push(" 💭 ", task.body.content.replace(/\n/g, " "));
	if (withId && task.id) parts.push(` ^${blockIdFor(task.id)}`);
	return parts.join("");
}

// 兼容旧格式（整条 base64 taskId）与新格式（16 位十六进制）
export const BLOCK_ID_RE = /\s+\^ms-todo-([0-9a-zA-Z=+_/-]+)\s*$/;

/**
 * 比较前后两版笔记文本里哪些任务被勾选/取消勾选。
 * 按 block id 比对而不是按行号——同步会重排（已完成沉底），按行号会把
 * 挪位置的相邻行误判成"勾选变化"。
 */
export function diffToggles(before: string, after: string): { taskId: string; done: boolean }[] {
	const seen = new Map<string, boolean>();
	for (const line of before.split("\n")) {
		const parsed = parseLine(line);
		if (parsed?.taskId) seen.set(parsed.taskId, parsed.done);
	}
	const out: { taskId: string; done: boolean }[] = [];
	for (const line of after.split("\n")) {
		const parsed = parseLine(line);
		if (!parsed?.taskId) continue;
		const was = seen.get(parsed.taskId);
		if (was !== undefined && was !== parsed.done) out.push({ taskId: parsed.taskId, done: parsed.done });
	}
	return out;
}

/** Parse a checkbox line into (title, done, indent, taskId). */
export function parseLine(
	line: string
): { title: string; done: boolean; indent: string; taskId?: string } | null {
	const m = /^(\s*)- \[( |x|X)\] (.*)$/.exec(line);
	if (!m) return null;
	let title = m[3];
	const idMatch = BLOCK_ID_RE.exec(title);
	const taskId = idMatch?.[1];
	if (idMatch) title = title.slice(0, idMatch.index);
	// strip obsidian-task-plugin style metadata (emoji + optional date/text run)
	title = title.replace(/\s*(?:📅|💭|🛫|⏳|✅)\s*[^📅💭🛫⏳✅]*/g, "").trim();
	return { title, done: m[2].toLowerCase() === "x", indent: m[1], taskId };
}

/** Format due date for Graph API. */
export function toGraphDate(d: string): { dateTime: string; timeZone: string } {
	return { dateTime: `${d}T00:00:00.000`, timeZone: "UTC" };
}
