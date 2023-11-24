import RootStore from "@stores/RootStore";
import { makeAutoObservable } from "mobx";
import { THEME_TYPE } from "@src/themes/ThemeProvider";

class SettingsStore {
	public readonly rootStore: RootStore;
	selectedTheme: THEME_TYPE = THEME_TYPE.DARK_THEME;

	constructor(rootStore: RootStore) {
		this.rootStore = rootStore;
		makeAutoObservable(this);
	}

	walletModalOpened: boolean = false;
	setWalletModalOpened = (s: boolean) => (this.walletModalOpened = s);

	marketSelectionOpened: boolean = false;
	setMarketSelectionOpened = (s: boolean) => (this.marketSelectionOpened = s);

	isCurrentMarketPerp: boolean = false;
	setCurrentMarketPerp = (s: boolean) => (this.isCurrentMarketPerp = s);
}

export default SettingsStore;
