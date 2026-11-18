import { App, PluginSettingTab, Setting } from "obsidian";
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
					.onClick(() => void this.plugin.signIn())
			)
			.addButton((b) =>
				b
					.setButtonText("同步全部清单")
					.setDisabled(!this.plugin.settings.refreshToken)
					.onClick(() => void this.plugin.runSyncAll())
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
