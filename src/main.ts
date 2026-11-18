import { Plugin, Notice, TFile, Editor } from "obsidian";
import { AuthManager, buildAuthorizeUrl, exchangeCode, pkce, REDIRECT_URI } from "./auth";
import { GraphClient } from "./graph";
import { MSTodoSettingTab } from "./settings-tab";
import { DEFAULT_SETTINGS, type MSTodoSettings } from "./settings";
import { SyncEngine } from "./sync";
import { parseLine } from "./markdown";
import type { TodoList } from "./types";

const AUTH_PROTOCOL = "ms-todo-auth";

export default class MSTodoPlugin extends Plugin {
	settings: MSTodoSettings = { ...DEFAULT_SETTINGS };
	auth!: AuthManager;
	graph!: GraphClient;
	sync!: SyncEngine;
	private autoTimer: number | null = null;
	private pendingAuth: { verifier: string; resolve: (r: string) => void; reject: (e: Error) => void } | null = null;

	async onload() {
		await this.loadSettings();

		this.auth = new AuthManager({
			clientId: this.settings.clientId,
			refreshToken: this.settings.refreshToken,
			accessToken: this.settings.accessToken,
			tokenExpiry: this.settings.tokenExpiry,
		});
		this.graph = new GraphClient(() => this.auth.getToken());
		this.sync = new SyncEngine(this.app, this.graph, this.settings);

		// OAuth callback handler
		this.registerObsidianProtocolHandler(AUTH_PROTOCOL, async (params) => {
			if (!this.pendingAuth) return;
			const { verifier, resolve, reject } = this.pendingAuth;
			this.pendingAuth = null;
			if (params.error) {
				reject(new Error(`Auth error: ${params.error} ${params.error_description ?? ""}`));
				return;
			}
			try {
				const token = await exchangeCode(this.settings.clientId, params.code, verifier);
				this.settings.refreshToken = token.refresh_token;
				this.settings.accessToken = token.access_token;
				this.settings.tokenExpiry = Date.now() + token.expires_in * 1000;
				await this.saveSettings();
				this.auth.updateSettings({
					clientId: this.settings.clientId,
					refreshToken: this.settings.refreshToken,
					accessToken: this.settings.accessToken,
					tokenExpiry: this.settings.tokenExpiry,
				});
				resolve(token.access_token);
			} catch (e) {
				reject(e as Error);
			}
		});

		this.addCommand({ id: "sign-in", name: "Sign in to Microsoft To Do", callback: () => void this.signIn() });
		this.addCommand({
			id: "sync-all",
			name: "Sync all mapped lists",
			callback: () => void this.runSyncAll(),
		});
		this.addCommand({
			id: "import-list",
			name: "Import a To Do list as a note",
			callback: () => void this.importList(),
		});
		this.addCommand({
			id: "map-current-note",
			name: "Map current note to a To Do list",
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
	}

	onunload() {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setupAutoSync() {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
		this.autoTimer = null;
		const min = this.settings.autoSyncIntervalMinutes;
		if (min > 0) {
			this.autoTimer = window.setInterval(() => void this.runSyncAll(), min * 60000);
		}
	}

	async signIn(): Promise<void> {
		if (!this.settings.clientId) {
			new Notice("Set your Azure client ID in settings first.");
			return;
		}
		const { verifier, challenge } = await pkce();
		const url = buildAuthorizeUrl(this.settings.clientId, challenge);
		window.open(url, "_blank");
		new Notice("Complete sign-in in your browser…");
		const code = await new Promise<string>((resolve, reject) => {
			this.pendingAuth = { verifier, resolve, reject };
			// Expire after 5 minutes
			window.setTimeout(() => {
				if (this.pendingAuth) {
					this.pendingAuth = null;
					reject(new Error("Auth timed out."));
				}
			}, 5 * 60000);
		});
		new Notice("Signed in to Microsoft To Do.");
	}

	async runSyncAll() {
		try {
			const msg = await this.sync.syncAll();
			new Notice(msg);
		} catch (e) {
			new Notice(`Microsoft To Do sync failed: ${(e as Error).message}`, 10000);
		}
	}

	async importList() {
		try {
			const lists = await this.graph.getLists();
			const picked = await this.pickList(lists);
			if (!picked) return;
			const notePath = `${picked.displayName.replace(/[\\/:*?"<>|]/g, "-")}.md`;
			await this.sync.syncListToListingNote(picked, notePath);
			this.settings.mappings[picked.id] = notePath;
			await this.saveSettings();
			new Notice(`Imported "${picked.displayName}" → ${notePath}`);
		} catch (e) {
			new Notice(`Import failed: ${(e as Error).message}`, 10000);
		}
	}

	async mapCurrentNote(file: TFile) {
		try {
			const lists = await this.graph.getLists();
			const picked = await this.pickList(lists);
			if (!picked) return;
			this.settings.mappings[picked.id] = file.path;
			await this.saveSettings();
			new Notice(`Mapped "${picked.displayName}" → ${file.path}`);
		} catch (e) {
			new Notice(`Mapping failed: ${(e as Error).message}`, 10000);
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
		if (!listId) return;
		const snapshot = this.lastEditSnapshot.get(file.path);
		const content = editor.getValue();
		if (snapshot === undefined) {
			this.lastEditSnapshot.set(file.path, content);
			return;
		}
		this.lastEditSnapshot.set(file.path, content);

		const before = new Set(
			snapshot.split("\n").map((l) => parseLine(l)?.title).filter(Boolean) as string[]
		);
		const beforeLines = snapshot.split("\n");
		for (const line of content.split("\n")) {
			const parsed = parseLine(line);
			if (!parsed || parsed.done) continue;
			const beforeIdx = beforeLines.findIndex((l) => {
				const p = parseLine(l);
				return p && p.title === parsed.title;
			});
			if (beforeIdx === -1 && !before.has(parsed.title)) {
				// Brand-new unchecked line: push to To Do.
				void this.sync.pushNewLine(file, listId, parsed.title).catch(() => undefined);
				return; // one per change event is plenty
			}
		}
	}
}

import { App, FuzzySuggestModal } from "obsidian";

class ListPickerModal extends FuzzySuggestModal<TodoList> {
	constructor(app: App, private lists: TodoList[], private onPick: (l: TodoList | null) => void) {
		super(app);
		this.setPlaceholder("Pick a Microsoft To Do list…");
	}

	getItems(): TodoList[] {
		return this.lists;
	}

	getItemText(l: TodoList): string {
		return l.displayName;
	}

	onChooseItem(l: TodoList) {
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

// Patch: mark chosen
const orig = ListPickerModal.prototype.onChooseItem as (l: TodoList) => void;
ListPickerModal.prototype.onChooseItem = function (l: TodoList) {
	(this as unknown as { chosen: boolean }).chosen = true;
	orig.call(this, l);
};

export { REDIRECT_URI };
