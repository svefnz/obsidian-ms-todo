import { requestUrl } from "obsidian";
import type { GraphListResponse, GraphTaskResponse, TodoList, TodoTask } from "./types";

const GRAPH = "https://graph.microsoft.com/v1.0";

export class GraphClient {
	constructor(private getToken: () => Promise<string>) {}

	private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
		const token = await this.getToken();
		const res = await requestUrl({
			url,
			method,
			contentType: "application/json",
			headers: { Authorization: `Bearer ${token}` },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (res.status >= 400) throw new Error(`Graph API 请求失败（${method} ${url}）：${res.status} ${res.text}`);
		return res.json as T;
	}
	async getLists(): Promise<TodoList[]> {
		const out: TodoList[] = [];
		let url: string | undefined = `${GRAPH}/me/todo/lists`;
		while (url) {
			const page: GraphListResponse = await this.req<GraphListResponse>("GET", url);
			out.push(...page.value);
			url = page["@odata.nextLink"];
		}
		return out;
	}

	async getTasks(listId: string): Promise<TodoTask[]> {
		const out: TodoTask[] = [];
		let url: string | undefined = `${GRAPH}/me/todo/lists/${listId}/tasks?$top=100`;
		while (url) {
			const page: GraphTaskResponse = await this.req<GraphTaskResponse>("GET", url);
			out.push(...page.value);
			url = page["@odata.nextLink"];
		}
		return out;
	}

	async createTask(listId: string, task: Partial<TodoTask>): Promise<TodoTask> {
		return this.req<TodoTask>("POST", `${GRAPH}/me/todo/lists/${listId}/tasks`, task);
	}

	async updateTask(listId: string, taskId: string, patch: Partial<TodoTask>): Promise<TodoTask> {
		return this.req<TodoTask>(
			"PATCH",
			`${GRAPH}/me/todo/lists/${listId}/tasks/${taskId}`,
			patch
		);
	}

	async deleteTask(listId: string, taskId: string): Promise<void> {
		await this.req<void>("DELETE", `${GRAPH}/me/todo/lists/${listId}/tasks/${taskId}`);
	}

	async completeTask(listId: string, taskId: string): Promise<TodoTask> {
		return this.updateTask(listId, taskId, {
			status: "completed",
			completedDateTime: { dateTime: new Date().toISOString(), timeZone: "UTC" },
		} as never);
	}
}
