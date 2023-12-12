import { makeAutoObservable, reaction, when } from "mobx";
import RootStore from "@stores/RootStore";
import { CONTRACT_ADDRESSES, IToken, TOKENS_BY_SYMBOL } from "@src/constants";
import BN from "@src/utils/BN";
import {
	AccountBalanceAbi,
	AccountBalanceAbi__factory,
	ClearingHouseAbi,
	ClearingHouseAbi__factory,
	InsuranceFundAbi,
	InsuranceFundAbi__factory,
	PerpMarketAbi,
	PerpMarketAbi__factory,
	ProxyAbi,
	ProxyAbi__factory,
	PythContractAbi,
	PythContractAbi__factory,
	VaultAbi,
	VaultAbi__factory,
} from "@src/contracts";
import { getPerpMarkets, PerpMarket } from "@src/services/ClearingHouseServise";
import { getUserPositions, Position } from "@src/services/AccountBalanceServise";
import { getPerpMarketPrices, getUserPerpOrders, PerpMarketPrice, PerpOrder } from "@src/services/PerpMarketService";

export interface SpotMarket {
	token0: IToken;
	token1: IToken;
	type: string;
	price?: BN;
	change24?: BN;
	symbol: string;
	leverage: null;
}

interface ContractConfig {
	proxyContract: ProxyAbi;
	accountBalanceContract: AccountBalanceAbi;
	clearingHouseContract: ClearingHouseAbi;
	insuranceFundContract: InsuranceFundAbi;
	perpMarketContract: PerpMarketAbi;
	vaultMarketContract: VaultAbi;
	pythContract: PythContractAbi;
}

export interface ISerializedTradeStore {
	favMarkets: string | null;
}

const spotMarketsConfig = [{ token0: TOKENS_BY_SYMBOL.UNI, token1: TOKENS_BY_SYMBOL.USDC }].map((v) => ({
	...v,
	symbol: `${v.token0.symbol}-${v.token1.symbol}`,
	type: "spot",
	leverage: null,
}));

class TradeStore {
	public rootStore: RootStore;

	constructor(rootStore: RootStore, initState?: ISerializedTradeStore) {
		this.rootStore = rootStore;
		makeAutoObservable(this);
		this.setSpotMarkets(spotMarketsConfig);
		this.initContracts();
		this.syncUserDataFromIndexer();
		this.syncDataFromIndexer();
		when(() => this.contracts != null, this.updateDataFromContracts);
		reaction(() => this.rootStore.accountStore.address, this.syncUserDataFromIndexer);
		setInterval(this.syncDataFromIndexer, 30 * 1000);
		//
		if (initState != null) {
			const markets = initState.favMarkets ?? "";
			this.setFavMarkets(markets.split(","));
		}
	}

	contracts: ContractConfig | null = null;
	private setContract = (c: ContractConfig | null) => (this.contracts = c);

	get contractsArray() {
		return this.contracts == null ? [] : Object.values(this.contracts);
	}

	initContracts = async () => {
		const { accountStore } = this.rootStore;
		const wallet = await accountStore.getWallet();
		if (wallet == null) return;
		const proxyContract = ProxyAbi__factory.connect(CONTRACT_ADDRESSES.proxy, wallet);
		const accountBalanceContract = AccountBalanceAbi__factory.connect(CONTRACT_ADDRESSES.accountBalance, wallet);
		const clearingHouseContract = ClearingHouseAbi__factory.connect(CONTRACT_ADDRESSES.clearingHouse, wallet);
		const insuranceFundContract = InsuranceFundAbi__factory.connect(CONTRACT_ADDRESSES.insuranceFund, wallet);
		const perpMarketContract = PerpMarketAbi__factory.connect(CONTRACT_ADDRESSES.perpMarket, wallet);
		const vaultMarketContract = VaultAbi__factory.connect(CONTRACT_ADDRESSES.vault, wallet);
		const pythContract = PythContractAbi__factory.connect(CONTRACT_ADDRESSES.pyth, wallet);
		this.setContract({
			proxyContract,
			accountBalanceContract,
			clearingHouseContract,
			insuranceFundContract,
			perpMarketContract,
			vaultMarketContract,
			pythContract,
		});
	};

	freeCollateral: BN | null = null;
	setFreeCollateral = (v: BN | null) => (this.freeCollateral = v);

	get formattedFreeCollateral() {
		return BN.formatUnits(this.freeCollateral ?? 0, TOKENS_BY_SYMBOL.USDC.decimals).toFormat(2);
	}

	marketSymbol: string | null = null;
	setMarketSymbol = (v: string) => (this.marketSymbol = v);

	get marketsConfig(): Record<string, SpotMarket | PerpMarket> {
		return [...spotMarketsConfig, ...this.perpMarkets].reduce(
			(acc, item) => {
				acc[item.symbol] = item;
				return acc;
			},
			{} as Record<string, SpotMarket | PerpMarket>,
		);
	}

	initialized: boolean = false;
	private setInitialized = (l: boolean) => (this.initialized = l);
	loading: boolean = false;
	private _setLoading = (l: boolean) => (this.loading = l);

	spotMarkets: SpotMarket[] = [];
	private setSpotMarkets = (v: SpotMarket[]) => (this.spotMarkets = v);

	perpMarkets: PerpMarket[] = [];
	private setPerpMarkets = (v: PerpMarket[]) => (this.perpMarkets = v);

	positions: Position[] = [];
	private setPosition = (v: Position[]) => (this.positions = v);

	perpOrders: PerpOrder[] = [];
	private setPerpOrders = (v: PerpOrder[]) => (this.perpOrders = v);

	perpPrices: Record<string, PerpMarketPrice> | null = null;
	private setPerpPrices = (v: Record<string, PerpMarketPrice> | null) => (this.perpPrices = v);

	get marketPrice() {
		if (this.marketSymbol == null) return BN.ZERO;
		const price = this.perpPrices == null ? BN.ZERO : this.perpPrices[this.marketSymbol]?.marketPrice;
		return BN.formatUnits(price, 6);
	}

	favMarkets: string[] = [];
	setFavMarkets = (v: string[]) => (this.favMarkets = v);

	serialize = (): ISerializedTradeStore => ({
		favMarkets: this.favMarkets.join(","),
	});
	addToFav = (marketId: string) => {
		if (!this.favMarkets.includes(marketId)) {
			this.setFavMarkets([...this.favMarkets, marketId]);
		}
		console.log(this.favMarkets);
	};
	removeFromFav = (marketId: string) => {
		const index = this.favMarkets.indexOf(marketId);
		index !== -1 && this.favMarkets.splice(index, 1);
	};

	get defaultMarketSymbol() {
		return this.spotMarkets[0].symbol;
	}

	get market() {
		return this.marketSymbol == null ? null : this.marketsConfig[this.marketSymbol];
	}

	get isMarketPerp() {
		return this.marketSymbol == null ? false : this.marketSymbol.includes("-PERP");
	}

	get currentMarket() {
		return this.marketSymbol == null ? null : this.marketsConfig[this.marketSymbol];
	}

	marketSelectionOpened: boolean = false;
	setMarketSelectionOpened = (s: boolean) => (this.marketSelectionOpened = s);

	deposit = async (amount: BN) => {
		const { accountStore } = this.rootStore;
		await accountStore.checkConnectionWithWallet();
		try {
			this._setLoading(true);
			const vault = CONTRACT_ADDRESSES.vault;
			const wallet = await accountStore.getWallet();
			if (wallet == null) return;
			const vaultContract = VaultAbi__factory.connect(vault, wallet);
			const { transactionResult } = await vaultContract.functions
				.deposit_collateral()
				.callParams({
					forward: { amount: amount.toString(), assetId: TOKENS_BY_SYMBOL.USDC.assetId },
				})
				.txParams({ gasPrice: 1 })
				.call();
			if (transactionResult != null) {
				const formattedAmount = BN.formatUnits(amount, TOKENS_BY_SYMBOL.USDC.decimals).toFormat(2);
				this.notifyThatActionIsSuccessful(`You have successfully deposited ${formattedAmount} USDC`);
			}
			await this.rootStore.accountStore.updateAccountBalances();
		} catch (e) {
			const errorText = e?.toString();
			console.log(errorText);
			this.notifyError(errorText ?? "", { type: "error" });
		} finally {
			this._setLoading(false);
		}
	};
	withdraw = async (amount: BN) => {
		const { accountStore, oracleStore } = this.rootStore;
		await accountStore.checkConnectionWithWallet();
		try {
			this._setLoading(true);
			const contracts = this.contractsToRead;
			const vault = CONTRACT_ADDRESSES.vault;
			const wallet = await accountStore.getWallet();
			if (wallet == null || contracts == null) return;
			const vaultContract = VaultAbi__factory.connect(vault, wallet);
			const fee = await oracleStore.getPythFee();
			if (oracleStore.updateData == null || fee == null) return;
			const { transactionResult } = await vaultContract.functions
				.withdraw_collateral(amount.toString(), oracleStore.updateData)
				.callParams({
					forward: { amount: fee, assetId: TOKENS_BY_SYMBOL.ETH.assetId },
				})
				.addContracts([
					contracts.pythContractAbi,
					contracts.accountBalanceAbi,
					contracts.proxyAbi,
					contracts.clearingHouseAbi,
				])
				.txParams({ gasPrice: 1 })
				.call();
			if (transactionResult != null) {
				const formattedAmount = BN.formatUnits(amount, TOKENS_BY_SYMBOL.USDC.decimals).toFormat(2);
				this.notifyThatActionIsSuccessful(`You have successfully ${formattedAmount} withdrawn USDC`);
			}
			await this.rootStore.accountStore.updateAccountBalances();
		} catch (e) {
			console.log(e);
			this.notifyError("Error", e?.toString());
		} finally {
			this._setLoading(false);
		}
	};

	notifyThatActionIsSuccessful = (title: string, txId?: string) => {
		this.rootStore.notificationStore.toast(title, {
			type: "success",
		});
	};
	notifyError = (title: string, error: any) => {
		console.error(error);
		this.rootStore.notificationStore.toast(title, {
			type: "error",
		});
	};

	syncUserDataFromIndexer = async () => {
		const address = (this.rootStore.accountStore.addressB256 ?? "").slice(2);
		const res = await Promise.all([getUserPositions(address), getUserPerpOrders(address)]);
		this.setPosition(res[0]);
		this.setPerpOrders(res[1]);
	};
	syncDataFromIndexer = async () => {
		const res = await Promise.all([getPerpMarkets(), getPerpMarketPrices()]);
		this.setPerpMarkets(res[0]);
		this.setPerpPrices(res[1]);
	};

	updateDataFromContracts = async () => {
		const { accountStore } = this.rootStore;
		if (accountStore.address == null || accountStore.addressInput == null) return;
		const contracts = this.contracts;
		if (contracts == null) return;
		await this.updateFreeCollateral(contracts?.vaultMarketContract);
		this.setInitialized(true);
	};

	updateFreeCollateral = async (vault: VaultAbi) => {
		const addressInput = this.rootStore.accountStore.addressInput;
		if (addressInput == null) return;
		const result = await vault.functions.get_free_collateral(addressInput).addContracts(this.contractsArray).simulate();
		if (result.value != null) {
			this.setFreeCollateral(new BN(result.value.value.toString()));
		}
	};

	get contractsToRead() {
		const { accountStore } = this.rootStore;
		const wallet = accountStore.walletToRead;
		if (wallet == null) return null;
		const vaultAbi = VaultAbi__factory.connect(CONTRACT_ADDRESSES.vault, wallet);
		const proxyAbi = ProxyAbi__factory.connect(CONTRACT_ADDRESSES.proxy, wallet);
		const clearingHouseAbi = ClearingHouseAbi__factory.connect(CONTRACT_ADDRESSES.clearingHouse, wallet);
		const accountBalanceAbi = AccountBalanceAbi__factory.connect(CONTRACT_ADDRESSES.accountBalance, wallet);
		const insuranceFundAbi = InsuranceFundAbi__factory.connect(CONTRACT_ADDRESSES.insuranceFund, wallet);
		const pythContractAbi = PythContractAbi__factory.connect(CONTRACT_ADDRESSES.pyth, wallet);
		return {
			vaultAbi,
			proxyAbi,
			clearingHouseAbi,
			accountBalanceAbi,
			insuranceFundAbi,
			pythContractAbi,
		};
	}
}

export default TradeStore;
