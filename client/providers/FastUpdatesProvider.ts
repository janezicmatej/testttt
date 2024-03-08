import type { BytesLike } from 'ethers'
import { sha256 } from 'ethers'
import type { TransactionReceipt } from 'web3-types'
import { encodePacked } from 'web3-utils'
import type { Logger } from 'winston'

import { FEEDS } from '../../deployment/config'
import type { PriceDeltas, Proof } from '../utils/'
import {
    calculateRandomness,
    generateSortitionKey,
    generateVerifiableRandomnessProof,
} from '../utils/'
import { signMessage } from '../utils/'

import type { ExamplePriceFeedProvider } from './ExamplePriceFeedProvider'
import type { Web3Provider } from './Web3Provider'

/**
 * Represents a provider for fast updates.
 */
export class FastUpdatesProvider {
    private readonly key = generateSortitionKey()
    private lastRegisteredEpoch: number

    constructor(
        private readonly provider: Web3Provider,
        private readonly priceFeedProvider: ExamplePriceFeedProvider,
        private readonly epochLen: number,
        private readonly weight: number,
        private readonly address: string,
        private readonly privateKey: string,
        private readonly logger: Logger
    ) {
        this.lastRegisteredEpoch = -1
        this.logger.info(
            `FastUpdatesProvider initialized at ${provider.account.address}`
        )
    }

    /**
     * Initializes the FastUpdatesProvider.
     * Waits for a new reward epoch and registers as a voter for the next epoch.
     * @returns A Promise that resolves once the initialization is complete.
     */
    public async init(): Promise<void> {
        const nextEpoch = await this.provider.delayAfterRewardEpochEdge(
            this.epochLen
        )
        const txReceipt = await this.registerAsVoter(nextEpoch, this.weight)
        if (Number(txReceipt.status) === 1) {
            this.logger.info(
                `Block ${txReceipt.blockNumber}, Voter registration for epoch ${nextEpoch} successful`
            )
        } else {
            this.logger.error(
                `Block ${txReceipt.blockNumber}, Voter registration for epoch ${nextEpoch} failed`
            )
        }
    }

    /**
     * Registers the current user as a voter for a specific epoch with a given weight.
     * @param epoch - The epoch number to register for.
     * @param weight - The weight of the voter.
     * @param addToNonce - An optional value to add to the nonce.
     * @returns A promise that resolves to the transaction receipt.
     */
    private async registerAsVoter(
        epoch: number,
        weight: number,
        addToNonce?: number
    ): Promise<TransactionReceipt> {
        const txReceipt = await this.provider.registerAsAVoter(
            epoch,
            this.key,
            weight,
            this.address,
            addToNonce
        )
        this.lastRegisteredEpoch = epoch
        this.logger.info(
            `Gas consumed by registerAsVoter ${txReceipt.gasUsed.toString()}`
        )
        return txReceipt
    }

    /**
     * Submits updates to the provider.
     *
     * @param proof - The proof object.
     * @param replicate - The replicate value.
     * @param deltas - The deltas array.
     * @param submissionBlockNum - The submission block number.
     * @param addToNonce - Optional parameter to add to the nonce.
     * @returns A promise that resolves to the transaction receipt.
     */
    private async submitUpdates(
        proof: Proof,
        replicate: string,
        deltas: [string[], string],
        submissionBlockNum: string,
        addToNonce?: number
    ): Promise<TransactionReceipt> {
        const msg = encodePacked(
            { value: submissionBlockNum, type: 'uint256' },
            { value: replicate, type: 'uint256' },
            { value: proof.gamma.x.toString(), type: 'uint256' },
            { value: proof.gamma.y.toString(), type: 'uint256' },
            { value: proof.c.toString(), type: 'uint256' },
            { value: proof.s.toString(), type: 'uint256' },
            { value: deltas[0][0] as string, type: 'bytes32' },
            { value: deltas[0][1] as string, type: 'bytes32' },
            { value: deltas[0][2] as string, type: 'bytes32' },
            { value: deltas[0][3] as string, type: 'bytes32' },
            { value: deltas[0][4] as string, type: 'bytes32' },
            { value: deltas[0][5] as string, type: 'bytes32' },
            { value: deltas[0][6] as string, type: 'bytes32' },
            { value: deltas[1], type: 'bytes32' }
        )
        const signature = signMessage(
            this.provider.web3,
            sha256(msg as BytesLike),
            this.privateKey
        )

        const receipt = await this.provider.submitUpdates(
            proof,
            replicate,
            deltas,
            submissionBlockNum,
            signature,
            addToNonce
        )
        this.logger.info(
            `Gas consumed by submitUpdate ${receipt.gasUsed.toString()}`
        )
        return receipt
    }

    /**
     * Retrieves the weight from the provider for the current address.
     * @returns A Promise that resolves to a string representing the weight.
     */
    private async getWeight(): Promise<string> {
        return await this.provider.getWeight(this.provider.account.address)
    }

    /**
     * Tries to submit updates based on the provided parameters.
     *
     * @param myWeight - The weight of the updates to be submitted.
     * @param blockNum - The block number for which the updates are being submitted.
     * @param seed - The seed value used for generating randomness.
     * @returns A Promise that resolves to void.
     */
    private async tryToSubmitUpdates(
        deltas: PriceDeltas,
        myWeight: number,
        blockNum: bigint,
        seed: string
    ): Promise<void> {
        let addToNonce = 0
        const blockNumStr = blockNum.toString()
        const cutoff = await this.provider.getCurrentScoreCutoff()

        const promises = []
        for (let rep = 0; rep < myWeight; rep++) {
            const repStr = rep.toString()
            const r: bigint = calculateRandomness(
                this.key,
                seed,
                blockNumStr,
                repStr
            )

            if (r < BigInt(cutoff)) {
                const proof: Proof = generateVerifiableRandomnessProof(
                    this.key,
                    seed,
                    blockNumStr,
                    repStr
                )

                this.logger.debug(
                    `Block: ${blockNum}, Rep: ${rep}, Update: ${deltas[1]}`
                )
                promises.push(
                    this.submitUpdates(
                        proof,
                        repStr,
                        deltas[0],
                        blockNumStr,
                        addToNonce
                    )
                        .then((receipt: TransactionReceipt) => {
                            this.logger.info(
                                `Block: ${receipt.blockNumber}, Update successful, ${deltas[1]}`
                            )
                        })
                        .catch((error) => {
                            this.logger.error(
                                `Block: ${blockNum}, Failed to submit updates ${error}`
                            )
                        })
                )
                addToNonce++
            }
        }
        // Only submit updates for the current block
        const currentBlockNum = await this.provider.getBlockNumber()
        if (currentBlockNum === blockNum) {
            await Promise.all(promises)
        }
    }

    /**
     * Re-registers the provider for the next epoch.
     *
     * @param epoch - The current epoch number.
     * @returns A promise that resolves to a boolean indicating whether the re-registration was successful.
     */
    private async reRegister(epoch: number): Promise<boolean> {
        const txReceipt = await this.registerAsVoter(epoch + 1, this.weight)

        if (Number(txReceipt.status) === 1) {
            this.logger.info(
                `Epoch: ${epoch + 1} (Block ${txReceipt.blockNumber}), Registration successful`
            )
        } else {
            this.logger.error(`Epoch: ${epoch + 1}, Registration failed`)
        }
        return Number(txReceipt.status) === 1
    }

    /**
     * Runs the FastUpdatesProvider.
     * This method waits for a new epoch, performs necessary operations within each epoch,
     * and waits for the next block to continue the process.
     * @returns A Promise that resolves to void.
     */
    public async run(): Promise<void> {
        this.logger.info('Waiting for a new epoch...')
        await this.provider.waitForNewEpoch(this.epochLen)

        let currentWeight: string = ''
        let currentBaseSeed: bigint = 0n

        for (;;) {
            const blockNum = Number(await this.provider.getBlockNumber())
            const epoch = Math.floor((blockNum + 1) / this.epochLen)

            // Within the last 4 blocks of the epoch, re-register for the next epoch
            if (blockNum % this.epochLen >= this.epochLen - 4) {
                if (epoch + 1 > this.lastRegisteredEpoch) {
                    const registered = await this.reRegister(epoch)
                    if (registered) {
                        // If successful, wait for the next epoch
                        await this.provider.waitForNewEpoch(this.epochLen)
                    } else {
                        // If failed, wait for the next block to try again
                        await this.provider.waitForBlock(blockNum + 1)
                        continue
                    }
                }
            }

            // Get the weight and the seed for the current epoch
            if (blockNum % this.epochLen === 0) {
                ;[currentWeight, currentBaseSeed] = await Promise.all([
                    this.getWeight(),
                    this.provider.getBaseSeed(),
                ])
                this.logger.info(`Epoch: ${epoch}, Weight: ${currentWeight}`)
            }

            // Fetch the on-chain and off-chain prices
            const onChainPrices: number[] = (
                await this.provider.fetchCurrentPrices(Array.from(FEEDS))
            ).map((x) => Number(x))
            const offChainPrices = this.priceFeedProvider.getCurrentPrices(
                Array.from(FEEDS)
            )

            this.logger.info(
                `blockNumber: ${blockNum}, onChainPrices: ${onChainPrices.join(', ')}, offChainPrices: ${offChainPrices.join(', ')}`
            )
            // Compare the on-chain and off-chain prices
            const deltas: PriceDeltas =
                this.priceFeedProvider.getFastUpdateDeltas(
                    onChainPrices,
                    offChainPrices
                )
            // Don't submit updates if there are no changes
            const rep = deltas[1]
            if (!rep.includes('+') && !rep.includes('-')) {
                this.logger.debug(`No updates for block ${blockNum}`)
            } else {
                await this.tryToSubmitUpdates(
                    deltas,
                    Number(currentWeight),
                    BigInt(blockNum),
                    currentBaseSeed.toString()
                )
            }

            await this.provider.waitForBlock(blockNum + 1)
        }
    }
}
