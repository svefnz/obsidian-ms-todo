import type { TodoTask } from "./types";
/** Map a TodoTask to the metadata we embed in the note. */
export function taskToMetadata(task: TodoTask): Record<string, string> {
	const meta: Record<string, string> = { "ms-todo-id": task.id, "ms-todo-list": "" };
	if (task.dueDateTime) meta["ms-todo-due"] = task.dueDateTime.dateTime.slice(0, 10);
	if (task.body?.content) meta["ms-todo-note"] = task.body.content;
	return meta;
}

/**
 * Build a checkbox line for a task.
 * The trailing `^ms-todo-<id>` block id is what lets later syncs match the
 * line to the task by id instead of by title (titles get renamed).
 */
export function taskToLine(task: TodoTask, indent = "", withId = true): string {
	const done = task.status === "completed" || task.status === "autoCompleted";
	const parts: string[] = [indent, done ? "- [x] " : "- [ ] ", task.title];
	if (task.dueDateTime) parts.push(" 📅 ", task.dueDateTime.dateTime.slice(0, 10));
	if (task.body?.content) parts.push(" 💭 ", task.body.content.replace(/\n/g, " "));
	if (withId && task.id) parts.push(` ^ms-todo-${task.id}`);
	return parts.join("");
}

export const BLOCK_ID_RE = /\s+\^ms-todo-([0-9a-zA-Z-]+)\s*$/;

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
