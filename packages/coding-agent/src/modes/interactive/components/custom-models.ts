import type { Api, Model } from "@earendil-works/pi-ai";
import { Container, type Focusable, getKeybindings, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { customModelKey } from "../../../core/custom-models.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import type { ModelRole, ModelRoleSettings } from "../../../core/settings-manager.js";
import { getSelectListTheme } from "../theme/theme.js";

export interface CustomModelsOptions {
	modelRegistry: ModelRegistry;
	models: ReadonlyArray<Model<Api>>;
	roles: ModelRoleSettings;
	onRolesChanged: (roles: ModelRoleSettings) => void;
	onDiscover?: (provider: string) => Promise<string[]>;
	onCancel: () => void;
}

/** Management view for configured models and task-role profiles. */
export class CustomModelsComponent extends Container implements Focusable {
	private focusedState = false;
	private readonly list: SelectList;
	private readonly options: CustomModelsOptions;
	private roles: ModelRoleSettings;
	private models: ReadonlyArray<Model<Api>>;
	get focused(): boolean {
		return this.focusedState;
	}
	set focused(value: boolean) {
		this.focusedState = value;
	}
	constructor(options: CustomModelsOptions) {
		super();
		this.options = options;
		this.roles = structuredClone(options.roles);
		this.models = options.models;
		const items: SelectItem[] = options.models.map((model) => ({
			value: customModelKey(model.provider, model.id),
			label: `${model.provider}/${model.id}`,
			description: model.name,
		}));
		items.push({ value: "__discover__", label: "Discover models", description: "Fetch a provider catalog" });
		this.list = new SelectList(items, 10, getSelectListTheme());
		this.list.onSelect = (item) => void this.select(item.value);
		this.addChild(new Text("Custom Models", 1, 0));
		this.addChild(new Text("Enter to assign · d to discover · Esc to close", 1, 0));
		this.addChild(this.list);
	}
	private async select(value: string): Promise<void> {
		if (value === "__discover__") {
			const provider = this.models[0]?.provider;
			if (!provider || !this.options.onDiscover) return;
			try {
				await this.options.onDiscover(provider);
			} catch {
				/* UI remains usable after discovery errors. */
			}
			return;
		}
		const roles: ModelRole[] = ["plan", "build", "delegate"];
		const role = roles.find((candidate) => !this.roles[candidate]);
		if (!role) return;
		const model = this.models.find((candidate) => customModelKey(candidate.provider, candidate.id) === value);
		if (!model) return;
		this.roles[role] = { modelKey: value, source: "custom" };
		this.options.onRolesChanged(structuredClone(this.roles));
	}
	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
			return;
		}
		if (keyData === "d") {
			const provider = this.models[0]?.provider;
			if (provider && this.options.onDiscover) void this.options.onDiscover(provider);
			return;
		}
		this.list.handleInput(keyData);
	}
}
