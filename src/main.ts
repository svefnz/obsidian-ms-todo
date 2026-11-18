import { Plugin, Notice, TFile, Editor } from "obsidian";
import { AuthManager, buildAuthorizeUrl, exchangeCode, pkce, startCallbackServer } from "./auth";
import { GraphClient } from "./graph";
import { MSTodoSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS, type MSTodoSettings } from "./settings";
import { SyncEngine } from "./sync";
import { parseLine, taskToLine } from "./markdown";
import type { TodoList } from "./types";

export default class MSTodoPlugin extends Plugin {
	settings: MSTodoSettings = { ...DEFAULT_SETTINGS };
	auth!: AuthManager;
	graph!: GraphClient;
	sync!: SyncEngine;
	private autoTimer: number | null = null;
	private syncing = false;
	private lastSyncAt = 0;
	listsCache: TodoList[] | null = null;

	async onload() {
		await this.loadSettings();

		this.auth = new AuthManager({
			clientId: this.settings.clientId,
			tenant: this.settings.tenant,
			refreshToken: this.settings.refreshToken,
			accessToken: this.settings.accessToken,
			tokenExpiry: this.settings.tokenExpiry,
		});
		this.graph = new GraphClient(() => this.auth.getToken());
		this.sync = new SyncEngine(this.app, this.graph, this.settings, () => this.saveSettings());

		this.addCommand({ id: "sign-in", name: "登录 Microsoft To Do", callback: () => void this.signIn() });
		this.addCommand({
			id: "sync-all",
			name: "同步全部已映射清单",
			callback: () => void this.runSyncAll(),
		});
		this.addCommand({
			id: "import-list",
			name: "导入 To Do 清单为笔记",
			callback: () => void this.importList(),
		});
		this.addCommand({
			id: "map-current-note",
			name: "将当前笔记映射到 To Do 清单",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (checking) return true;
				void this.mapCurrentNote(file);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("editor-change", (editor, info) => {
				const file = info && "file" in info ? (info.file as TFile | null) : null;
				if (!file) return;
				void this.handleEditorChange(editor, file);
			})
		);

		this.addSettingTab(new MSTodoSettingTab(this.app, this));
		this.setupAutoSync();
		// 从手机/别的窗口切回来时补一次拉取（仅在开启自动同步时，最多每分钟一次）
		this.registerDomEvent(window, "focus", () => void this.maybeSyncOnFocus());
	}

	onunload() {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.auth.updateSettings({
			clientId: this.settings.clientId,
			tenant: this.settings.tenant,
			refreshToken: this.settings.refreshToken,
			accessToken: this.settings.accessToken,
			tokenExpiry: this.settings.tokenExpiry,
		});
	}

	setupAutoSync() {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
		this.autoTimer = null;
		const min = this.settings.autoSyncIntervalMinutes;
		if (min > 0) {
			this.autoTimer = window.setInterval(() => void this.runSyncAll(true), min * 60000);
		}
	}

	async signIn(): Promise<void> {
		if (!this.settings.clientId) {
			new Notice("请先在插件设置中填写 Azure 客户端 ID。");
			return;
		}
		const { verifier, challenge } = await pkce();
		// 先启动本地回调服务，再打开浏览器，避免竞态
		let callback;
		try {
			callback = await startCallbackServer();
		} catch (e) {
			new Notice(`登录失败：${(e as Error).message}`, 12000);
			return;
		}
		const url = buildAuthorizeUrl(
			this.settings.clientId,
			challenge,
			this.settings.tenant,
			callback.redirectUri
		);
		window.open(url, "_blank");
		new Notice("请在浏览器中完成 Microsoft 账号登录…", 8000);
		try {
			const { code, error } = await callback.result;
			if (!code) throw new Error(`登录失败：${error ?? "未获得授权码"}`);
			const token = await exchangeCode(
				this.settings.clientId,
				code,
				verifier,
				this.settings.tenant,
				callback.redirectUri
			);
			this.settings.refreshToken = token.refresh_token;
			this.settings.accessToken = token.access_token;
			this.settings.tokenExpiry = Date.now() + token.expires_in * 1000;
			await this.saveSettings();
			this.listsCache = null;
			new Notice("已登录 Microsoft To Do。");
		} catch (e) {
			new Notice(`登录失败：${(e as Error).message}`, 12000);
		}
	}

	async runSyncAll(quiet = false) {
		if (this.syncing) return; // 定时/焦点/手动撞车时只跑一个
		this.syncing = true;
		try {
			const msg = await this.sync.syncAll();
			this.lastSyncAt = Date.now();
			if (!quiet) new Notice(msg);
		} catch (e) {
			new Notice(`Microsoft To Do 同步失败：${(e as Error).message}`, 10000);
		} finally {
			this.syncing = false;
		}
	}

	/** 窗口重新获得焦点时补一次同步：失败/未登录静默，间隔不足 1 分钟不重复跑 */
	async maybeSyncOnFocus() {
		if (this.settings.autoSyncIntervalMinutes <= 0 || !this.settings.refreshToken) return;
		if (Date.now() - this.lastSyncAt < 60_000) return;
		await this.runSyncAll(true);
	}

	/** 清单列表缓存，避免设置页每次重绘都打一次 API */
	async getLists(force = false): Promise<TodoList[]> {
		if (!force && this.listsCache) return this.listsCache;
		this.listsCache = await this.graph.getLists();
		return this.listsCache;
	}

	/** 同步文件夹变更后把已同步的笔记搬到该文件夹（旧路径删除） */
	async migrateSyncFolder(to: string): Promise<number> {
		const { moved, missing } = await this.sync.migrateInto(to);
		if (moved > 0) {
			new Notice(`已迁移 ${moved} 篇笔记到「${to}」，旧路径已删除。`, 6000);
		} else {
			new Notice(
				missing.length > 0
					? `没有可迁移的笔记：${missing.length} 条映射指向的文件已不存在（请先执行一次同步）。`
					: `笔记已在「${to}」中，无需迁移。`,
				8000
			);
		}
		return moved;
	}

	async importList() {
		try {
			const lists = await this.getLists(true);
			const picked = await this.pickList(lists);
			if (!picked) return;
			const notePath = `${picked.displayName.replace(/[\\/:*?"<>|]/g, "-")}.md`;
			await this.sync.syncListToListingNote(picked, notePath);
			this.settings.mappings[picked.id] = notePath;
			await this.saveSettings();
			new Notice(`已导入「${picked.displayName}」→ ${notePath}`);
		} catch (e) {
			new Notice(`导入失败：${(e as Error).message}`, 10000);
		}
	}

	async mapCurrentNote(file: TFile) {
		try {
			const lists = await this.getLists(true);
			const picked = await this.pickList(lists);
			if (!picked) return;
			this.settings.mappings[picked.id] = file.path;
			await this.saveSettings();
			new Notice(`已映射「${picked.displayName}」→ ${file.path}`);
		} catch (e) {
			new Notice(`映射失败：${(e as Error).message}`, 10000);
		}
	}

	private pickList(lists: TodoList[]): Promise<TodoList | null> {
		return new Promise((resolve) => {
			const modal = new ListPickerModal(this.app, lists, resolve);
			modal.open();
		});
	}

	/**
	 * On editor change: if the active file is mapped to a list, detect newly
	 * created unchecked lines and push them to To Do, and checkbox toggles.
	 * Debounced per file to avoid spamming the API while typing.
	 */
	private lastEditSnapshot = new Map<string, string>();
	private async handleEditorChange(editor: Editor, file: TFile) {
		const listId = Object.entries(this.settings.mappings).find(([, p]) => p === file.path)?.[0];
		if (!listId || this.settings.disabledListIds.includes(listId)) return;
		const snapshot = this.lastEditSnapshot.get(file.path);
		const content = editor.getValue();
		if (snapshot === undefined) {
			this.lastEditSnapshot.set(file.path, content);
			return;
		}
		this.lastEditSnapshot.set(file.path, content);

		const beforeLines = snapshot.split("\n");
		const nowLines = content.split("\n");

		// 勾选状态变化 -> 回写 To Do（只对带 block id 的行可靠）
		for (let i = 0; i < Math.min(beforeLines.length, nowLines.length); i++) {
			const b = parseLine(beforeLines[i]);
			const n = parseLine(nowLines[i]);
			if (!b || !n || !n.taskId || b.done === n.done) continue;
			void this.sync.pushToggle(file, listId, n.taskId, n.done).catch(() => undefined);
		}

		// 新出现的未勾选行 -> 建成 To Do 任务，并把 block id 写回该行
		const beforeTitles = new Set(
			beforeLines.map((l) => parseLine(l)?.title).filter((t): t is string => Boolean(t))
		);
		for (let i = 0; i < nowLines.length; i++) {
			const parsed = parseLine(nowLines[i]);
			if (!parsed || parsed.done || parsed.taskId || beforeTitles.has(parsed.title)) continue;
			const task = await this.sync.pushNewLine(file, listId, parsed.title).catch(() => null);
			if (task) editor.setLine(i, taskToLine(task, parsed.indent));
			return; // one per change event is plenty
		}
	}
}

import { App, FuzzySuggestModal } from "obsidian";

class ListPickerModal extends FuzzySuggestModal<TodoList> {
	constructor(app: App, private lists: TodoList[], private onPick: (l: TodoList | null) => void) {
		super(app);
		this.setPlaceholder("选择一个 Microsoft To Do 清单…");
	}

	getItems(): TodoList[] {
		return this.lists;
	}

	getItemText(l: TodoList): string {
		return l.displayName;
	}

	onChooseItem(l: TodoList) {
		this.chosen = true;
		this.onPick(l);
	}

	onClose() {
		// If closed without choosing, resolve null after a tick
		setTimeout(() => {
			if (!this.chosen) this.onPick(null);
		}, 0);
	}

	private chosen = false;
}
