import {
  LiquidityPoolKeysV4,
} from '@raydium-io/raydium-sdk'
import {
  NATIVE_MINT,
  getAssociatedTokenAddress,
} from '@solana/spl-token'
import {
  Keypair,
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  ComputeBudgetProgram,
  SystemProgram,
  sendAndConfirmTransaction,
  VersionedTransaction,
  sendAndConfirmRawTransaction,
} from '@solana/web3.js'
import {
  ADDITIONAL_FEE,
  BUY_AMOUNT,
  BUY_INTERVAL_MAX,
  BUY_INTERVAL_MIN,
  BUY_LOWER_AMOUNT,
  BUY_UPPER_AMOUNT,
  DISTRIBUTE_WALLET_NUM,
  IS_RANDOM,
  LOG_LEVEL,
  PRIVATE_KEY,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TOKEN_MINT,
  TX_FEE,
} from './constants'
import { Data, editJson, logger, PoolKeys, readJson, saveDataToFile, sleep } from './utils'
import base58 from 'bs58'
import { getBuyTx, getSellTx } from './utils/swapOnlyAmm'
import { execute } from './executor/legacy'

export const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
})

export const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY))
const baseMint = new PublicKey(TOKEN_MINT)
const distritbutionNum = DISTRIBUTE_WALLET_NUM > 20 ? 20 : DISTRIBUTE_WALLET_NUM
let quoteVault: PublicKey | null = null
let vaultAmount: number = 0
let poolKeys: LiquidityPoolKeysV4
let sold: number = 0
let bought: number = 0
let totalSolPut: number = 0
let changeAmount = 0
let buyNum = 0
let sellNum = 0
logger.level = LOG_LEVEL


const main = async () => {

  const solBalance = (await solanaConnection.getBalance(mainKp.publicKey)) / LAMPORTS_PER_SOL
  console.log(`Volume bot is running`)
  console.log(`Wallet address: ${mainKp.publicKey.toBase58()}`)
  console.log(`Pool token mint: ${baseMint.toBase58()}`)
  console.log(`Wallet SOL balance: ${solBalance.toFixed(3)}SOL`)
  console.log(`Buying interval max: ${BUY_INTERVAL_MAX}ms`)
  console.log(`Buying interval min: ${BUY_INTERVAL_MIN}ms`)
  console.log(`Buy upper limit amount: ${BUY_UPPER_AMOUNT}SOL`)
  console.log(`Buy lower limit amount: ${BUY_LOWER_AMOUNT}SOL`)
  console.log(`Distribute SOL to ${distritbutionNum} wallets`)

  let poolId: PublicKey
  poolKeys = await PoolKeys.fetchPoolKeyInfo(solanaConnection, baseMint, NATIVE_MINT)
  poolId = poolKeys.id
  quoteVault = poolKeys.quoteVault
  console.log(`Successfully fetched pool info`)
  console.log(`Pool id: ${poolId.toBase58()}`)

  // await makeSwap(baseMint.toBase58(), 1000000, "buy", mainKp)

  while (true) {
    try {
      const data = await distributeSol(mainKp, distritbutionNum)
      if (data == null)
        continue
      for (let i = 0; i < distritbutionNum; i++) {
        try {
          const BUY_INTERVAL = Number((Math.random() * (BUY_INTERVAL_MAX - BUY_INTERVAL_MIN) + BUY_INTERVAL_MIN).toFixed(5))
          await sleep(BUY_INTERVAL)
          const { kp: newWallet, buyAmount } = data[i]

          makeSwap(baseMint.toBase58(), buyAmount, "buy", newWallet)

          setTimeout(() => {
            makeSwap(baseMint.toBase58(), buyAmount, "sell", newWallet)
          }, BUY_INTERVAL)

        } catch (error) {
          console.log("Failed to buy token")
        }
      }
    } catch (error) {
      console.log("Failed to distribute")
    }
  }
}


const distributeSol = async (mainKp: Keypair, distritbutionNum: number) => {
  const data: Data[] = []
  const wallets = []
  try {
    const sendSolTx = new Transaction()
      .add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100 * TX_FEE }),
      )
    for (let i = 0; i < distritbutionNum; i++) {
      let buyAmount: number
      if (IS_RANDOM)
        buyAmount = Number((Math.random() * (BUY_UPPER_AMOUNT - BUY_LOWER_AMOUNT) + BUY_LOWER_AMOUNT).toFixed(6))
      else
        buyAmount = BUY_AMOUNT
      if (buyAmount <= 0.001)
        buyAmount = 0.001

      const wallet = Keypair.generate()
      wallets.push({ kp: wallet, buyAmount })

      sendSolTx.add(
        SystemProgram.transfer({
          fromPubkey: mainKp.publicKey,
          toPubkey: wallet.publicKey,
          lamports: Math.round((buyAmount + ADDITIONAL_FEE) * LAMPORTS_PER_SOL)
        })
      )
    }

    sendSolTx.recentBlockhash = (await solanaConnection.getLatestBlockhash()).blockhash
    sendSolTx.feePayer = mainKp.publicKey

    console.log("Trying to send SOL")
    const sig = await sendAndConfirmTransaction(solanaConnection, sendSolTx, [mainKp], { maxRetries: 5 })
    const solTransferTx = `https://solscan.io/tx/${sig}`

    wallets.map((wallet) => {
      data.push({
        privateKey: base58.encode(wallet.kp.secretKey),
        pubkey: wallet.kp.publicKey.toBase58(),
        solBalance: wallet.buyAmount + ADDITIONAL_FEE,
        solTransferTx: solTransferTx,
        tokenBalance: null,
        tokenBuyTx: null,
        tokenSellTx: null
      })
    })
    saveDataToFile(data)
    console.log("Success in transferring sol: ", solTransferTx)
    return wallets
  } catch (error) {
    console.log("🚀 ~ distributeSol ~ error:", error)
    console.log(`Failed to transfer SOL`)
    return null
  }
}


// const buy = async (newWallet: Keypair, baseMint: PublicKey, buyAmount: number, poolId: PublicKey) => {
//   let solBalance: number = 0
//   try {
//     solBalance = await solanaConnection.getBalance(newWallet.publicKey)
//   } catch (error) {
//     console.log("Error getting balance of wallet")
//     return
//   }
//   if (solBalance == 0) {
//     return
//   }
//   try {
//     const tx = await getBuyTx(solanaConnection, newWallet, baseMint, NATIVE_MINT, buyAmount, poolId.toBase58())
//     if (tx == null) {
//       console.log(`Error getting buy transaction`)
//       return null
//     }
//     const latestBlockhash = await solanaConnection.getLatestBlockhash()
//     const txSig = await execute(tx, latestBlockhash)
//     const tokenBuyTx = txSig ? `https://solscan.io/tx/${txSig}` : ''
//     bought++
//     totalSolPut += buyAmount
//     const tokenAta = await getAssociatedTokenAddress(baseMint, newWallet.publicKey)
//     const tokenBalance = (await solanaConnection.getTokenAccountBalance(tokenAta)).value.uiAmount

//     editJson({
//       tokenBuyTx,
//       pubkey: newWallet.publicKey.toBase58(),
//       solBalance: solBalance / 10 ** 9 - buyAmount,
//       tokenBalance
//     })
//     return tokenBuyTx
//   } catch (error) {
//     console.log("Error in buying token")
//     return null
//   }
// }


// const sell = async (poolId: PublicKey, baseMint: PublicKey) => {
//   try {
//     const data: Data[] = readJson()
//     if (data.length == 0) {
//       console.log("🚀 ~ sell ~ data.length:", data.length)
//       await sleep(1000)
//       return
//     }

//     const dataToSellAll = data.filter((datum: Data) => datum.tokenBalance && datum.tokenSellTx == null)
//     if (dataToSellAll.length == 0) {
//       console.log("🚀 ~ sell ~ dataToSellAll.length:", dataToSellAll.length)
//       await sleep(1000)
//       return
//     }
//     const ind = (Math.random() * dataToSellAll.length)
//     const dataToSell = dataToSellAll[ind]
//     const wallet = Keypair.fromSecretKey(base58.decode(dataToSell.privateKey))

//     const tokenAta = await getAssociatedTokenAddress(baseMint, wallet.publicKey)
//     const tokenBalInfo = await solanaConnection.getTokenAccountBalance(tokenAta)
//     if (!tokenBalInfo) {
//       console.log("Balance incorrect")
//       return null
//     }
//     const tokenBalance = tokenBalInfo.value.amount

//     try {
//       const sellTx = await getSellTx(solanaConnection, wallet, baseMint, NATIVE_MINT, tokenBalance, poolId.toBase58())

//       if (sellTx == null) {
//         console.log(`Error getting sell transaction`)
//         return null
//       }

//       const latestBlockhashForSell = await solanaConnection.getLatestBlockhash()
//       const txSellSig = await execute(sellTx, latestBlockhashForSell, false)
//       const tokenSellTx = txSellSig ? `https://solscan.io/tx/${txSellSig}` : ''
//       const solBalance = await solanaConnection.getBalance(wallet.publicKey)
//       sold++
//       totalSolPut -= solBalance

//       editJson({
//         pubkey: wallet.publicKey.toBase58(),
//         tokenSellTx,
//         tokenBalance: 0,
//         solBalance
//       })

//     } catch (error) {
//       console.log("error in sell action :", error)
//     }
//   } catch (error) {
//     console.log("data or balance error:", error)
//     console.log("Failed to sell token")
//   }
// }



async function makeSwap(tokenAddress: string, amount: number, type: "buy" | "sell", wallet: Keypair) {
  try {
    const solAddress = NATIVE_MINT.toBase58()
    const rAmount = (amount - ADDITIONAL_FEE) * LAMPORTS_PER_SOL;
    if (rAmount < 0) {
      console.log("amount is less than gas Fee");
      return;
    }
    console.log("swap amount: ", rAmount / LAMPORTS_PER_SOL);
    console.log("swap type: ", type);
    console.log("swap wallet", wallet.publicKey.toString());

    const fixedSwapValLamports = Math.floor(rAmount);
    let response;
    if (type == "buy") {
      response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=' + solAddress + '&outputMint=' + tokenAddress + '&amount=' + fixedSwapValLamports + '&slippageBps=90');
    } else {
      response = await fetch('https://quote-api.jup.ag/v6/quote?inputMint=' + tokenAddress + '&outputMint=' + solAddress + '&amount=' + fixedSwapValLamports + '&slippageBps=90');
    }
    const routes = await response.json();
    const transaction_response = await fetch('https://quote-api.jup.ag/v6/swap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse: routes,
        userPublicKey: wallet.publicKey.toString(),
        wrapUnwrapSOL: true,
        prioritizationFeeLamports: "auto",
        dynamicComputeUnitLimit: true,
      })
    });
    const transactions = await transaction_response.json();
    const { swapTransaction } = transactions;
    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');

    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    // sign the transaction
    transaction.sign([wallet]);
    // Execute the transaction

    const rawTransaction = transaction.serialize()
    const txid = await solanaConnection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });
    await solanaConnection.confirmTransaction(txid);
    console.log(`https://solscan.io/tx/${txid}`);

    if (type == "buy") {
      const solBalance = await solanaConnection.getBalance(wallet.publicKey)
      editJson({
        tokenBuyTx: `https://solscan.io/tx/${txid}`,
        pubkey: wallet.publicKey.toBase58(),
        solBalance: solBalance,
      })
    } else {
      editJson({
        pubkey: wallet.publicKey.toBase58(),
        tokenSellTx: `https://solscan.io/tx/${txid}`,
        tokenBalance: 0,
        solBalance: rAmount / 10 ** 9
      })
    }
  } catch (error) {
    console.log("Error in ", type, " transaction")
  }

}














































main()