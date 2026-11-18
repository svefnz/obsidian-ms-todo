import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type MSTodoPlugin from "./main";

const AZURE_APP_REGISTRATIONS =
	"https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const AZURE_NEW_REGISTRATION =
	"https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false";
const AZURE_DOC = "https://github.com/svefnz/obsidian-ms-todo#%E9%85%8D%E7%BD%AE";

export class MSTodoSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MSTodoPlugin) {
		super(app, plugin);
	}

	private migrateTimer: number | null = null;

	private async runMigration(): Promise<void> {
		try {
			const moved = await this.plugin.migrateSyncFolder(this.plugin.settings.syncFolder);
			if (moved > 0) this.display(); // 路径变了，重绘清单列表
		} catch (e) {
			new Notice(`迁移笔记失败：${(e as Error).message}`, 15000);
		}
	}

	/** 账号下所有清单 + 勾选同步 / 取消同步 */
	private async renderLists(el: HTMLElement): Promise<void> {
		el.empty();
		el.createEl("h3", { text: "要同步的清单" });
		if (!this.plugin.settings.refreshToken) {
			el.createEl("p", { text: "登录后可在此勾选需要同步的清单。" });
			return;
		}
		const status = el.createEl("p", { text: "正在读取清单…" });
		let lists;
		try {
			lists = await this.plugin.getLists(true);
		} catch (e) {
			status.setText(`读取清单失败：${(e as Error).message}`);
			return;
		}
		status.remove();
		if (lists.length === 0) {
			el.createEl("p", { text: "账号下没有 Microsoft To Do 清单。" });
			return;
		}

		const head = new Setting(el).setName("清单").setDesc("勾选后参与同步；取消勾选会立刻删除该清单的笔记（移入系统废纸篓，可找回）。");
		head.addButton((b) =>
			b.setButtonText("刷新清单").onClick(async () => {
				this.plugin.listsCache = null;
				await this.renderLists(el);
			})
		);

		for (const list of lists) {
			const shownName = `「${list.displayName}」`;
			const enabled = !this.plugin.settings.disabledListIds.includes(list.id);
			const path = this.plugin.settings.mappings[list.id];
			new Setting(el)
				.setName(shownName)
				.setDesc(path ? path : "尚未同步")
				.addToggle((t) =>
					t.setValue(enabled).onChange(async (v) => {
						const disabled = new Set(this.plugin.settings.disabledListIds);
						if (v) disabled.delete(list.id);
						else disabled.add(list.id);
						this.plugin.settings.disabledListIds = [...disabled];
						await this.plugin.saveSettings();
						if (v) {
							const path = this.plugin.settings.mappings[list.id];
							if (path) new Notice(`「${list.displayName}」已重新开启同步，下次同步会更新 ${path}。`);
						} else {
							try {
								const gone = await this.plugin.sync.removeListNote(list.id);
								new Notice(
									gone
										? `已停止同步「${list.displayName}」，笔记 ${gone} 已移入废纸篓。`
										: `已停止同步「${list.displayName}」（它还没有笔记）。`
								);
								this.display(); // 路径描述要清掉
							} catch (e) {
								new Notice(`删除笔记失败：${(e as Error).message}`, 10000);
							}
						}
					})
				);
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Microsoft To Do 同步" });

		new Setting(containerEl)
			.setName("Azure 应用注册")
			.setDesc(
				"① 点击右侧按钮打开 Azure 门户 → ② 新建应用注册（无需客户端密钥）→ ③ 在“身份验证”中添加平台「移动和桌面应用程序」，重定向 URI 填 http://localhost:42813/ms-todo-auth → ④ 复制“应用程序(客户端) ID”粘贴到下方"
			)
			.addButton((b) =>
				b
					.setButtonText("新建应用注册 ↗")
					.setCta()
					.onClick(() => window.open(AZURE_NEW_REGISTRATION, "_blank"))
			)
			.addButton((b) =>
				b
					.setButtonText("注册列表 ↗")
					.onClick(() => window.open(AZURE_APP_REGISTRATIONS, "_blank"))
			)
			.addExtraButton((b) =>
				b.setIcon("help").setTooltip("查看详细步骤").onClick(() => window.open(AZURE_DOC, "_blank"))
			);

		new Setting(containerEl)
			.setName("客户端 ID（Client ID）")
			.setDesc("Azure 应用注册中的“应用程序(客户端) ID”。")
			.addText((t) =>
				t
					.setPlaceholder("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (v) => {
						this.plugin.settings.clientId = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("租户（Tenant）")
			.setDesc(
				"common = 工作/学校账户 + 个人账户（Azure 应用需选择“任何组织目录中的账户和个人 Microsoft 账户”）；consumers = 仅个人 Microsoft 账户；也可填你的租户 ID 或域名（仅限单租户应用）。"
			)
			.addText((t) =>
				t
					.setPlaceholder("common")
					.setValue(this.plugin.settings.tenant)
					.onChange(async (v) => {
						this.plugin.settings.tenant = v.trim() || "common";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("登录状态")
			.setDesc(this.plugin.settings.refreshToken ? "已登录 Microsoft 账号。" : "尚未登录。")
			.addButton((b) =>
				b
					.setButtonText(this.plugin.settings.refreshToken ? "重新登录" : "登录")
					.setCta()
					.onClick(async () => {
						b.setButtonText("等待浏览器授权…").setDisabled(true);
						await this.plugin.signIn();
						// signIn 结束后重绘，让登录状态/按钮/同步按钮立刻反映结果
						this.display();
					})
			)
			.addButton((b) =>
				b
					.setButtonText("同步全部清单")
					.setDisabled(!this.plugin.settings.refreshToken)
					.onClick(() => void this.plugin.runSyncAll())
			);

		const listsBox = containerEl.createDiv();
		void this.renderLists(listsBox);

		new Setting(containerEl)
			.setName("同步文件夹")
			.setDesc("执行“同步全部清单”时，为尚未映射的清单自动创建笔记的位置。")
			.addText((t) =>
				t
					.setPlaceholder("Microsoft To Do")
					.setValue(this.plugin.settings.syncFolder)
					.onChange(async (v) => {
						this.plugin.settings.syncFolder = v.trim() || "Microsoft To Do";
						await this.plugin.saveSettings();
						// 输入过程中每个字符都会触发，等停止输入再迁移一次
						if (this.migrateTimer !== null) window.clearTimeout(this.migrateTimer);
						this.migrateTimer = window.setTimeout(() => {
							this.migrateTimer = null;
							void this.runMigration();
						}, 800);
					})
			)
			.addButton((b) =>
				b.setButtonText("立即迁移笔记").onClick(async () => {
					await this.runMigration();
				})
			);

		new Setting(containerEl)
			.setName("隐藏已完成任务")
			.setDesc("同步时忽略在 Microsoft To Do 中已完成的任务。")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideCompleted).onChange(async (v) => {
					this.plugin.settings.hideCompleted = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("自动同步间隔（分钟）")
			.setDesc("0 表示仅手动同步。")
			.addText((t) =>
				t
					.setValue(String(this.plugin.settings.autoSyncIntervalMinutes))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.autoSyncIntervalMinutes = Number.isFinite(n) && n > 0 ? n : 0;
						await this.plugin.saveSettings();
						this.plugin.setupAutoSync();
					})
			);

		const entries = Object.entries(this.plugin.settings.mappings);
		if (entries.length > 0) {
			containerEl.createEl("h3", { text: "清单 → 笔记 映射" }).setAttr("style", "margin-top: 1.5em;");
			for (const [listId, path] of entries) {
				new Setting(containerEl).setName(path).setDesc(`清单 ID：${listId}`).addButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("解除映射")
						.onClick(async () => {
							delete this.plugin.settings.mappings[listId];
							await this.plugin.saveSettings();
							this.display();
						})
				);
			}
		}
	}
}
