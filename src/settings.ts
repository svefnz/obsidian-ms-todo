import type { TodoList, TodoTask } from "./types";

export interface SyncMapping {
	/** list id -> note path */
	[listId: string]: string;
}

export interface MSTodoSettings extends Record<string, unknown> {
	clientId: string;
	tenant: string;
	refreshToken?: string;
	accessToken?: string;
	tokenExpiry?: number;
	defaultListId?: string;
	mappings: SyncMapping;
	/** Remove tasks from the note when they're completed in To Do */
	hideCompleted: boolean;
	/** 自动导入清单时使用的笔记文件夹 */
	syncFolder: string;
	autoSyncIntervalMinutes: number;
}

export const DEFAULT_SETTINGS: MSTodoSettings = {
	clientId: "",
	tenant: "common",
	mappings: {},
	syncFolder: "Microsoft To Do",
	hideCompleted: false,
	autoSyncIntervalMinutes: 0,
};

export { type TodoList, type TodoTask };
