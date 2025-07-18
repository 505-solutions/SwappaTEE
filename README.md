# cross-chain-resolver-example

To run this file, you need to install yarn packages, install foundry, run the docker container and copy the `.env.example` to `.env`. 

## Installation

Install example deps

```shell
yarn install
cd xrpl-tee && yarn install
```

Install [foundry](https://book.getfoundry.sh/getting-started/installation)

```shell
curl -L https://foundry.paradigm.xyz | bash
```

Install contract deps

```shell
forge install
```

## Running

To run tests you need to provide fork urls for Ethereum and Bsc

```shell
yarn test
```

### example.env

```
SRC_CHAIN_RPC=https://eth.merkle.io
DST_CHAIN_RPC=wss://bsc-rpc.publicnode.com
SRC_CHAIN_CREATE_FORK=true
DST_CHAIN_CREATE_FORK=true
```

### Setup docker container
```
docker compose build
docker compose up
```

```
(0) 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" Owner of EscrowFactory
(1) 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" User
(2) 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" Resolver
```
