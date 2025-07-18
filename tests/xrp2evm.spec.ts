import 'dotenv/config'
import {expect, jest} from '@jest/globals'

import {createServer, CreateServerReturnType} from 'prool'
import {anvil} from 'prool/instances'

import Sdk from '@1inch/cross-chain-sdk'
import {
    computeAddress,
    ContractFactory,
    JsonRpcProvider,
    MaxUint256,
    parseEther,
    parseUnits,
    randomBytes,
    Wallet as SignerWallet
} from 'ethers'
import {uint8ArrayToHex, UINT_40_MAX} from '@1inch/byte-utils'
import assert from 'node:assert'
import {ChainConfig, config} from './config'
import {Wallet} from './wallet'
import {Resolver} from './resolver'
import {EscrowFactory} from './escrow-factory'
import factoryContract from '../dist/contracts/TestEscrowFactory.sol/TestEscrowFactory.json'
import resolverContract from '../dist/contracts/Resolver.sol/Resolver.json'
import * as xrplUtils from './xrpUtils'
import * as xrplClient from '../xrpl-tee/client'

const {Address} = Sdk

jest.setTimeout(1000 * 60)

const userPk = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const resolverPk = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'

// eslint-disable-next-line max-lines-per-function
describe('Resolving example', () => {
    const srcChainId = config.chain.source.chainId
    const dstChainId = config.chain.destination.chainId

    type Chain = {
        node?: CreateServerReturnType | undefined
        provider: JsonRpcProvider
        escrowFactory: string
        resolver: string
    }

    let src: Chain
    let dst: Chain

    let srcChainUser: Wallet
    let dstChainUser: Wallet
    let srcChainResolver: Wallet
    let dstChainResolver: Wallet

    let srcFactory: EscrowFactory
    let dstFactory: EscrowFactory
    let srcResolverContract: Wallet
    let dstResolverContract: Wallet

    let srcTimestamp: bigint

    async function increaseTime(t: number): Promise<void> {
        await Promise.all([src, dst].map((chain) => chain.provider.send('evm_increaseTime', [t])))
    }

    beforeAll(async () => {
        ;[src, dst] = await Promise.all([initChain(config.chain.source), initChain(config.chain.destination)])

        srcChainUser = new Wallet(userPk, src.provider)
        dstChainUser = new Wallet(userPk, dst.provider)
        srcChainResolver = new Wallet(resolverPk, src.provider)
        dstChainResolver = new Wallet(resolverPk, dst.provider)

        srcFactory = new EscrowFactory(src.provider, src.escrowFactory)
        dstFactory = new EscrowFactory(dst.provider, dst.escrowFactory)
        // get 1000 USDC for user in SRC chain and approve to LOP
        await srcChainUser.topUpFromDonor(
            config.chain.source.tokens.USDC.address,
            config.chain.source.tokens.USDC.donor,
            parseUnits('1000', 6)
        )
        await srcChainUser.approveToken(
            config.chain.source.tokens.USDC.address,
            config.chain.source.limitOrderProtocol,
            MaxUint256
        )

        // get 2000 USDC for resolver in DST chain
        srcResolverContract = await Wallet.fromAddress(src.resolver, src.provider)
        dstResolverContract = await Wallet.fromAddress(dst.resolver, dst.provider)
        await dstResolverContract.topUpFromDonor(
            config.chain.destination.tokens.USDC.address,
            config.chain.destination.tokens.USDC.donor,
            parseUnits('2000', 6)
        )
        // top up contract for approve
        await dstChainResolver.transfer(dst.resolver, parseEther('1'))
        await dstResolverContract.unlimitedApprove(config.chain.destination.tokens.USDC.address, dst.escrowFactory)

        srcTimestamp = BigInt((await src.provider.getBlock('latest'))!.timestamp)
    })

    async function getBalances(
        srcToken: string,
        dstToken: string
    ): Promise<{src: {user: bigint; resolver: bigint}; dst: {user: bigint; resolver: bigint}}> {
        return {
            src: {
                user: await srcChainUser.tokenBalance(srcToken),
                resolver: await srcResolverContract.tokenBalance(srcToken)
            },
            dst: {
                user: await dstChainUser.tokenBalance(dstToken),
                resolver: await dstResolverContract.tokenBalance(dstToken)
            }
        }
    }

    afterAll(async () => {
        src.provider.destroy()
        dst.provider.destroy()
        await Promise.all([src.node?.stop(), dst.node?.stop()])
    })

    // eslint-disable-next-line max-lines-per-function
    describe('Fill', () => {
        it.skip('should swap XRP on XRPL -> Ethereum USDC. Single fill only', async () => {
            const initialBalances = await getBalances(
                config.chain.source.tokens.USDC.address,
                config.chain.destination.tokens.USDC.address
            )

            // Taker side: Create XRPL wallet and client
            const xrpMaker = xrplUtils.createXRPLWalletFromEthKey(userPk)
            const xrpTaker = xrplUtils.createXRPLWalletFromEthKey(resolverPk)

            // Refuel both wallets with testnet XRP from faucet
            await xrplUtils.refuelWalletFromFaucet(xrpMaker)
            await xrplUtils.refuelWalletFromFaucet(xrpTaker)

            const xrpClient = new xrplClient.XRPLEscrowClient({
                baseUrl: 'http://localhost:3000'
            })
            

            // User creates order
            const secret = uint8ArrayToHex(randomBytes(32)) // note: use crypto secure random number in real world
            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('1', 6),
                    takingAmount: parseUnits('1', 6),
                    takerAsset: new Address(config.chain.destination.tokens.USDC.address),
                    makerAsset: new Address(config.chain.source.tokens.USDC.address)
                },
                {
                    hashLock: Sdk.HashLock.forSingleFill(secret),
                    timeLocks: Sdk.TimeLocks.new({
                        srcWithdrawal: 10n, // 10sec finality lock for test
                        srcPublicWithdrawal: 120n, // 2m for private withdrawal
                        srcCancellation: 121n, // 1sec public withdrawal
                        srcPublicCancellation: 122n, // 1sec private cancellation
                        dstWithdrawal: 10n, // 10sec finality lock for test
                        dstPublicWithdrawal: 100n, // 100sec private withdrawal
                        dstCancellation: 101n // 1sec public withdrawal
                    }),
                    srcChainId,
                    dstChainId,
                    srcSafetyDeposit: parseUnits('1', 5),
                    dstSafetyDeposit: parseUnits('1', 5)
                },
                {
                    auction: new Sdk.AuctionDetails({
                        initialRateBump: 0,
                        points: [],
                        duration: 120n,
                        startTime: srcTimestamp
                    }),
                    whitelist: [
                        {
                            address: new Address(src.resolver),
                            allowFrom: 0n
                        }
                    ],
                    resolvingStartTime: 0n
                },
                {
                    nonce: Sdk.randBigInt(UINT_40_MAX),
                    allowPartialFills: false,
                    allowMultipleFills: false
                }
            )

            const orderHash = order.getOrderHash(srcChainId)
            const resolverContract = new Resolver(src.resolver, dst.resolver)

            const deployedAtTimelocks = order.escrowExtension.timeLocks
            deployedAtTimelocks.setDeployedAt(srcTimestamp)
            
            const dstImmutables = Sdk.Immutables.new({
                orderHash: orderHash,
                hashLock: order.escrowExtension.hashLockInfo,
                maker: new Address(await srcChainUser.getAddress()),
                taker: new Address(resolverContract.dstAddress),
                token: new Address(config.chain.destination.tokens.USDC.address),
                amount: order.takingAmount,
                safetyDeposit: order.escrowExtension.dstSafetyDeposit,
                timeLocks: deployedAtTimelocks
            })

            const dstComplement = Sdk.DstImmutablesComplement.new({
                maker: new Address(await srcChainUser.getAddress()),
                amount: order.takingAmount,
                token: new Address(config.chain.destination.tokens.USDC.address),
                safetyDeposit: order.escrowExtension.dstSafetyDeposit,
            })

            console.log(`[${dstChainId}]`, `Depositing ${dstImmutables.amount} for order ${orderHash}`)
            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                resolverContract.deployDst(dstImmutables)
            )
            console.log(`[${dstChainId}]`, `Created dst deposit for order ${orderHash} in tx ${dstDepositHash}`)

            const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()


            const dstEscrowAddress = new Sdk.EscrowFactory(new Address(dst.escrowFactory)).getDstEscrowAddress(
                dstImmutables,
                dstComplement,
                dstDeployedAt,
                new Address(resolverContract.dstAddress),
                ESCROW_DST_IMPLEMENTATION
            )

            // Relay initializes the escrow on the src chain
            const createEscrowPayload = {
                orderHash,
                hashlock: order.escrowExtension.hashLockInfo.toString(),
                maker: xrpMaker.address.toString(),
                taker: xrpTaker.address.toString(),
                token: "0x0000000000000000000000000000000000000000",
                amount: order.takingAmount.toString(),
                safetyDeposit: order.escrowExtension.dstSafetyDeposit.toString(),
                timelocks: order.escrowExtension.timeLocks.build().toString(),
            }
            console.log("Creating escrow on XRPL src", createEscrowPayload)
            const xrpEscrow = await xrpClient.createDestinationEscrow(createEscrowPayload)
            console.log("Created escrow on XRPL src", xrpEscrow)

            // Maker deposits funds to the escrow on the src chain
            const xrpDepositHash = await xrplUtils.sendXRP(xrpMaker, xrpEscrow.walletAddress, createEscrowPayload.amount)
            const xrplExplorer = `https://testnet.xrpl.org/transactions/${xrpDepositHash}`
            console.log("Maker deposited funds", xrplExplorer)

            // Taker deposits the fee
            const xrpFeeDepositHash = await xrplUtils.sendXRP(xrpTaker, xrpEscrow.walletAddress, createEscrowPayload.safetyDeposit)
            const xrplExplorer2 = `https://testnet.xrpl.org/transactions/${xrpFeeDepositHash}`
            console.log("Taker deposited the fee", xrplExplorer2)

            // Check if the escrow is funded
            const escrow = await xrpClient.fundEscrow(xrpEscrow.escrowId, {
                fromAddress: xrpMaker.address,
                txHash: [xrpDepositHash, xrpFeeDepositHash].join(',')
            })
            console.log("Escrow funded", escrow)
            

            await increaseTime(11)
            // User shares key after validation of dst escrow deployment
            console.log(`[${dstChainId}]`, `Withdrawing funds for user from ${dstEscrowAddress}`)
            await dstChainResolver.send(
                resolverContract.withdraw('dst', dstEscrowAddress, secret, dstImmutables.withDeployedAt(dstDeployedAt))
            )

            // withdraw from SRC XRPL escrow
            const xrplWithdrawal = await xrpClient.withdraw(xrpEscrow.escrowId, secret, xrpTaker.address, false)
            const xrplWithdrawalExplorer = `https://testnet.xrpl.org/transactions/${xrplWithdrawal.txHash}`
            console.log(`[XRPL]`, `Withdrew funds for user from ${xrpEscrow.walletAddress}`, xrplWithdrawalExplorer)

            const resultBalances = await getBalances(
                config.chain.source.tokens.USDC.address,
                config.chain.destination.tokens.USDC.address
            )

            // resolver transferred funds to user on destination chain
            expect(resultBalances.dst.user - initialBalances.dst.user).toBe(order.takingAmount)
            expect(initialBalances.dst.resolver - resultBalances.dst.resolver).toBe(order.takingAmount)
        })
    })

    describe('Cancel', () => {
        it('should cancel swap XRP XRPL -> Ethereum USDC', async () => {
            // Taker side: Create XRPL wallet and client
            const xrpMaker = xrplUtils.createXRPLWalletFromEthKey(userPk)
            const xrpTaker = xrplUtils.createXRPLWalletFromEthKey(resolverPk)

            // Refuel both wallets with testnet XRP from faucet
            await xrplUtils.refuelWalletFromFaucet(xrpMaker)
            await xrplUtils.refuelWalletFromFaucet(xrpTaker)

            const xrpClient = new xrplClient.XRPLEscrowClient({
                baseUrl: 'http://localhost:3000'
            })
            

            // User creates order
            const secret = uint8ArrayToHex(randomBytes(32)) // note: use crypto secure random number in real world
            const order = Sdk.CrossChainOrder.new(
                new Address(src.escrowFactory),
                {
                    salt: Sdk.randBigInt(1000n),
                    maker: new Address(await srcChainUser.getAddress()),
                    makingAmount: parseUnits('1', 6),
                    takingAmount: parseUnits('1', 6),
                    takerAsset: new Address(config.chain.destination.tokens.USDC.address),
                    makerAsset: new Address(config.chain.source.tokens.USDC.address)
                },
                {
                    hashLock: Sdk.HashLock.forSingleFill(secret),
                    timeLocks: Sdk.TimeLocks.new({
                        srcWithdrawal: 10n, // 10sec finality lock for test
                        srcPublicWithdrawal: 120n, // 2m for private withdrawal
                        srcCancellation: 121n, // 1sec public withdrawal
                        srcPublicCancellation: 122n, // 1sec private cancellation
                        dstWithdrawal: 10n, // 10sec finality lock for test
                        dstPublicWithdrawal: 100n, // 100sec private withdrawal
                        dstCancellation: 101n // 1sec public withdrawal
                    }),
                    srcChainId,
                    dstChainId,
                    srcSafetyDeposit: parseUnits('1', 5),
                    dstSafetyDeposit: parseUnits('1', 5)
                },
                {
                    auction: new Sdk.AuctionDetails({
                        initialRateBump: 0,
                        points: [],
                        duration: 120n,
                        startTime: srcTimestamp
                    }),
                    whitelist: [
                        {
                            address: new Address(src.resolver),
                            allowFrom: 0n
                        }
                    ],
                    resolvingStartTime: 0n
                },
                {
                    nonce: Sdk.randBigInt(UINT_40_MAX),
                    allowPartialFills: false,
                    allowMultipleFills: false
                }
            )

            const orderHash = order.getOrderHash(srcChainId)
            const resolverContract = new Resolver(src.resolver, dst.resolver)

            const deployedAtTimelocks = order.escrowExtension.timeLocks
            deployedAtTimelocks.setDeployedAt(srcTimestamp)
            
            const dstImmutables = Sdk.Immutables.new({
                orderHash: orderHash,
                hashLock: order.escrowExtension.hashLockInfo,
                maker: new Address(await srcChainUser.getAddress()),
                taker: new Address(resolverContract.dstAddress),
                token: new Address(config.chain.destination.tokens.USDC.address),
                amount: order.takingAmount,
                safetyDeposit: order.escrowExtension.dstSafetyDeposit,
                timeLocks: deployedAtTimelocks
            })

            const dstComplement = Sdk.DstImmutablesComplement.new({
                maker: new Address(await srcChainUser.getAddress()),
                amount: order.takingAmount,
                token: new Address(config.chain.destination.tokens.USDC.address),
                safetyDeposit: order.escrowExtension.dstSafetyDeposit,
            })

            console.log(`[${dstChainId}]`, `Depositing ${dstImmutables.amount} for order ${orderHash}`)
            const {txHash: dstDepositHash, blockTimestamp: dstDeployedAt} = await dstChainResolver.send(
                resolverContract.deployDst(dstImmutables)
            )
            console.log(`[${dstChainId}]`, `Created dst deposit for order ${orderHash} in tx ${dstDepositHash}`)

            const ESCROW_DST_IMPLEMENTATION = await dstFactory.getDestinationImpl()


            const dstEscrowAddress = new Sdk.EscrowFactory(new Address(dst.escrowFactory)).getDstEscrowAddress(
                dstImmutables,
                dstComplement,
                dstDeployedAt,
                new Address(resolverContract.dstAddress),
                ESCROW_DST_IMPLEMENTATION
            )

            // Relay initializes the escrow on the src chain
            const createEscrowPayload = {
                orderHash,
                hashlock: order.escrowExtension.hashLockInfo.toString(),
                maker: xrpMaker.address.toString(),
                taker: xrpTaker.address.toString(),
                token: "0x0000000000000000000000000000000000000000",
                amount: order.takingAmount.toString(),
                safetyDeposit: order.escrowExtension.dstSafetyDeposit.toString(),
                timelocks: order.escrowExtension.timeLocks.build().toString(),
                type: 'src'
            }
            console.log("Creating escrow on XRPL src", createEscrowPayload)
            const xrpEscrow = await xrpClient.createDestinationEscrow(createEscrowPayload)
            console.log("Created escrow on XRPL src", xrpEscrow)

            // Maker deposits funds to the escrow on the src chain
            const xrpDepositHash = await xrplUtils.sendXRP(xrpMaker, xrpEscrow.walletAddress, createEscrowPayload.amount)
            const xrplExplorer = `https://testnet.xrpl.org/transactions/${xrpDepositHash}`
            console.log("Maker deposited funds", xrplExplorer)

            // Taker deposits the fee
            const xrpFeeDepositHash = await xrplUtils.sendXRP(xrpTaker, xrpEscrow.walletAddress, createEscrowPayload.safetyDeposit)
            const xrplExplorer2 = `https://testnet.xrpl.org/transactions/${xrpFeeDepositHash}`
            console.log("Taker deposited the fee", xrplExplorer2)

            // Check if the escrow is funded
            const escrow = await xrpClient.fundEscrow(xrpEscrow.escrowId, {
                fromAddress: xrpMaker.address,
                txHash: [xrpDepositHash, xrpFeeDepositHash].join(',')
            })
            console.log("Escrow funded", escrow)
            

            await increaseTime(125)
            // user does not share secret, so cancel both escrows
            console.log(`[${dstChainId}]`, `Cancelling dst escrow ${dstEscrowAddress}`)
            await dstChainResolver.send(
                resolverContract.cancel('dst', dstEscrowAddress, dstImmutables.withDeployedAt(dstDeployedAt))
            )
            
            console.log(`[XRPL]`, `Cancelling escrow for ID: ${xrpEscrow.escrowId}`)

            const xrplCancellation = await xrpClient.cancel(xrpEscrow.escrowId, xrpTaker.address)
            console.log(`[XRPL]`, `Cancellation result:`, xrplCancellation)
            
            // Print explorer links for all cancellation transactions
            if (xrplCancellation.cancelTxs) {
                xrplCancellation.cancelTxs.forEach((tx, index) => {
                    const explorerLink = `https://testnet.xrpl.org/transactions/${tx.txHash}`
                    console.log(`[XRPL]`, `Cancellation tx ${index + 1}: ${tx.amount} XRP drops to ${tx.recipient}`, explorerLink)
                })
            }
        })
    })
})

async function initChain(
    cnf: ChainConfig
): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider; escrowFactory: string; resolver: string}> {
    const {node, provider} = await getProvider(cnf)
    const deployer = new SignerWallet(cnf.ownerPrivateKey, provider)

    // deploy EscrowFactory
    const escrowFactory = await deploy(
        factoryContract,
        [
            cnf.limitOrderProtocol,
            cnf.wrappedNative, // feeToken,
            Address.fromBigInt(0n).toString(), // accessToken,
            deployer.address, // owner
            60 * 30, // src rescue delay
            60 * 30 // dst rescue delay
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Escrow factory contract deployed to`, escrowFactory)

    // deploy Resolver contract
    const resolver = await deploy(
        resolverContract,
        [
            escrowFactory,
            cnf.limitOrderProtocol,
            computeAddress(resolverPk) // resolver as owner of contract
        ],
        provider,
        deployer
    )
    console.log(`[${cnf.chainId}]`, `Resolver contract deployed to`, resolver)

    return {node: node, provider, resolver, escrowFactory}
}

async function getProvider(cnf: ChainConfig): Promise<{node?: CreateServerReturnType; provider: JsonRpcProvider}> {
    if (!cnf.createFork) {
        return {
            provider: new JsonRpcProvider(cnf.url, cnf.chainId, {
                cacheTimeout: -1,
                staticNetwork: true
            })
        }
    }

    const node = createServer({
        instance: anvil({forkUrl: cnf.url, chainId: cnf.chainId}),
        limit: 1
    })
    await node.start()

    const address = node.address()
    assert(address)

    const provider = new JsonRpcProvider(`http://[${address.address}]:${address.port}/1`, cnf.chainId, {
        cacheTimeout: -1,
        staticNetwork: true
    })

    return {
        provider,
        node
    }
}

/**
 * Deploy contract and return its address
 */
async function deploy(
    json: {abi: any; bytecode: any},
    params: unknown[],
    provider: JsonRpcProvider,
    deployer: SignerWallet
): Promise<string> {
    const deployed = await new ContractFactory(json.abi, json.bytecode, deployer).deploy(...params)
    await deployed.waitForDeployment()

    return await deployed.getAddress()
}
