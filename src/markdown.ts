import type { TodoTask } from "./types";
/** Map a TodoTask to the metadata we embed in the note. */
export function taskToMetadata(task: TodoTask): Record<string, string> {
	const meta: Record<string, string> = { "ms-todo-id": task.id, "ms-todo-list": "" };
	if (task.dueDateTime) meta["ms-todo-due"] = task.dueDateTime.dateTime.slice(0, 10);
	if (task.body?.content) meta["ms-todo-note"] = task.body.content;
	return meta;
}

/** Build a checkbox line for a task. */
export function taskToLine(task: TodoTask, indent = ""): string {
	const done = task.status === "completed" || task.status === "autoCompleted";
	const parts: string[] = [indent, done ? "- [x] " : "- [ ] ", task.title];
	if (task.dueDateTime) parts.push(" 📅 ", task.dueDateTime.dateTime.slice(0, 10));
	if (task.body?.content) parts.push(" 💭 ", task.body.content.replace(/\n/g, " "));
	return parts.join("");
}

/** Parse a checkbox line into (title, done). */
export function parseLine(line: string): { title: string; done: boolean; indent: string } | null {
	const m = /^(\s*)- \[( |x|X)\] (.*)$/.exec(line);
	if (!m) return null;
	let title = m[3];
	// strip obsidian-task-plugin style metadata (emoji + optional date/text run)
	title = title.replace(/\s*(?:📅|💭|🛫|⏳|✅)\s*[^📅💭🛫⏳✅]*/g, "").trim();
	return { title, done: m[2].toLowerCase() === "x", indent: m[1] };
}

/** Format due date for Graph API. */
export function toGraphDate(d: string): { dateTime: string; timeZone: string } {
	return { dateTime: `${d}T00:00:00.000`, timeZone: "UTC" };
}
