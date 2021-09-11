import { AssetId } from '@aztec/barretenberg/asset';
import { BlockchainAsset, TxType } from '@aztec/barretenberg/blockchain';
import {
  ClientProofData,
  DefiClaimClientProofData,
  DefiDepositClientProofData,
  JoinSplitClientProofData,
  ProofId,
} from '@aztec/barretenberg/client_proofs';
import { AssetFeeQuote } from '@aztec/barretenberg/rollup_provider';
import { TxDao } from '../entity/tx';
import { PriceTracker } from './price_tracker';

export class FeeCalculator {
  constructor(
    private priceTracker: PriceTracker,
    private assets: BlockchainAsset[],
    private baseTxGas: number,
    private maxFeeGasPrice: bigint,
    private feeGasPriceMultiplier: number,
    private txsPerRollup: number,
    private publishInterval: number,
    private surplusRatios = [1, 0.9, 0.5, 0],
    private feeFreeAssets: AssetId[] = [],
  ) {}

  getMinTxFee(assetId: number, txType: TxType) {
    if (txType === TxType.ACCOUNT) {
      return 0n;
    }
    return this.getFeeConstant(assetId, txType) + this.getBaseFee(assetId);
  }

  getFeeQuotes(assetId: number): AssetFeeQuote {
    const baseFee = this.getBaseFee(assetId);
    return {
      feeConstants: [
        TxType.DEPOSIT,
        TxType.TRANSFER,
        TxType.WITHDRAW_TO_WALLET,
        TxType.WITHDRAW_TO_CONTRACT,
        TxType.ACCOUNT,
        TxType.DEFI_DEPOSIT,
        TxType.DEFI_CLAIM,
      ].map(txType => this.getFeeConstant(assetId, txType)),
      baseFeeQuotes: this.surplusRatios.map(ratio => ({
        fee: baseFee * (1n + BigInt(Math.round(this.txsPerRollup * (1 - ratio)))),
        time: Math.max(5 * 60, this.publishInterval * ratio),
      })),
    };
  }

  computeSurplusRatio(txs: TxDao[]) {
    const baseFee = this.getBaseFee(AssetId.ETH);
    if (!baseFee) {
      return 1;
    }

    const feeSurplus = txs
      .map(tx => {
        const { assetId, txFee } = this.getFeeForTxDao(tx);
        const minFee = this.getMinTxFee(assetId, tx.txType);
        return this.toEthPrice(assetId, txFee - minFee);
      })
      .reduce((acc, surplus) => acc + surplus, 0n);
    const ratio = 1 - Number(feeSurplus / baseFee) / this.txsPerRollup;
    return Math.min(1, Math.max(0, ratio));
  }

  private getBaseFee(assetId: AssetId) {
    if (this.feeFreeAssets.includes(assetId)) {
      return 0n;
    }
    return this.toAssetPrice(assetId, BigInt(this.baseTxGas));
  }

  private getFeeConstant(assetId: AssetId, txType: TxType) {
    if (this.feeFreeAssets.includes(assetId)) {
      return 0n;
    }
    return this.toAssetPrice(assetId, BigInt(this.assets[assetId].gasConstants[txType]));
  }

  private toAssetPrice(assetId: AssetId, gas: bigint) {
    const price = this.priceTracker.getAssetPrice(assetId);
    const { decimals } = this.assets[assetId];
    return !price ? 0n : this.applyGasPrice(gas * 10n ** BigInt(decimals)) / price;
  }

  private toEthPrice(assetId: AssetId, price: bigint) {
    if (assetId === AssetId.ETH) {
      return price;
    }
    const { decimals } = this.assets[assetId];
    return (price * this.priceTracker.getAssetPrice(assetId)) / 10n ** BigInt(decimals);
  }

  private applyGasPrice(value: bigint) {
    const gasPrice = this.priceTracker.getGasPrice();
    const expectedValue = (value * gasPrice * BigInt(this.feeGasPriceMultiplier * 100)) / 100n;
    const maxValue = this.maxFeeGasPrice ? value * this.maxFeeGasPrice : expectedValue;
    return expectedValue > maxValue ? maxValue : expectedValue;
  }

  private getFeeForTxDao(tx: TxDao) {
    if (tx.txType === TxType.ACCOUNT) {
      return { assetId: AssetId.ETH, txFee: 0n };
    }

    const proofData = new ClientProofData(tx.proofData);
    switch (proofData.proofId) {
      case ProofId.DEFI_DEPOSIT: {
        const { bridgeId, txFee } = new DefiDepositClientProofData(proofData);
        return { assetId: bridgeId.inputAssetId, txFee };
      }
      case ProofId.DEFI_CLAIM: {
        const { bridgeId, txFee } = new DefiClaimClientProofData(proofData);
        return { assetId: bridgeId.inputAssetId, txFee };
      }
    }

    const { assetId, txFee } = new JoinSplitClientProofData(proofData);
    return { assetId, txFee };
  }
}
