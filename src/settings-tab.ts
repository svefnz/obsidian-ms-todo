import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type MSTodoPlugin from "./main";

export class MSTodoSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MSTodoPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Microsoft Azure client ID")
			.setDesc("Application (client) ID from an Azure AD app registration with redirect URI https://localhost/ms-todo-auth")
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
			.setName("Hide completed tasks")
			.setDesc("When syncing, omit tasks that are completed in Microsoft To Do.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.hideCompleted).onChange(async (v) => {
					this.plugin.settings.hideCompleted = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto sync interval (minutes)")
			.setDesc("0 = manual sync only.")
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

		// Show existing mappings
		const entries = Object.entries(this.plugin.settings.mappings);
		if (entries.length > 0) {
			const head = containerEl.createEl("h3", { text: "List → note mappings" });
			head.setAttr("style", "margin-top: 1.5em;");
			for (const [listId, path] of entries) {
				new Setting(containerEl).setName(listId).setDesc(path).addButton((b) =>
					b.setIcon("trash").onClick(async () => {
						delete this.plugin.settings.mappings[listId];
						await this.plugin.saveSettings();
						this.display();
					})
				);
			}
		}
	}
}
