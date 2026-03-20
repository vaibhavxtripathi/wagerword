import * as StellarSdk from '@stellar/stellar-sdk'
import { isConnected, requestAccess, signTransaction } from '@stellar/freighter-api'

const CONTRACT_ID   = (import.meta.env.VITE_CONTRACT_ID       || '').trim()
const XLM_TOKEN     = (import.meta.env.VITE_XLM_TOKEN         || '').trim()
const ADMIN_ADDRESS = (import.meta.env.VITE_ADMIN_ADDRESS     || '').trim()
const NET           = (import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015').trim()
const RPC_URL       = (import.meta.env.VITE_SOROBAN_RPC_URL   || 'https://soroban-testnet.stellar.org').trim()
const DUMMY         = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN'

export const rpc = new StellarSdk.rpc.Server(RPC_URL)

export async function connectWallet() {
  const { isConnected: connected } = await isConnected()
  if (!connected) throw new Error('Freighter not installed.')
  const { address, error } = await requestAccess()
  if (error) throw new Error(error)
  return address
}

async function sendTxWithResult(publicKey, op) {
  const account = await rpc.getAccount(publicKey)
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE, networkPassphrase: NET,
  }).addOperation(op).setTimeout(60).build()
  const sim = await rpc.simulateTransaction(tx)
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(sim.error)
  const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build()
  const signed_r = await signTransaction(prepared.toXDR(), { networkPassphrase: NET })
  if (signed_r.error) throw new Error(signed_r.error)
  const signed = StellarSdk.TransactionBuilder.fromXDR(signed_r.signedTxXdr, NET)
  const sent = await rpc.sendTransaction(signed)
  // Poll and return result
  for (let i = 0; i < 30; i++) {
    const r = await rpc.getTransaction(sent.hash)
    if (r.status === 'SUCCESS') return { hash: sent.hash, txResult: r }
    if (r.status === 'FAILED')  throw new Error('Transaction failed on-chain')
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Transaction timed out')
}

async function sendTx(publicKey, op) {
  const { hash } = await sendTxWithResult(publicKey, op)
  return hash
}

async function readContract(op) {
  const dummy = new StellarSdk.Account(DUMMY, '0')
  const tx = new StellarSdk.TransactionBuilder(dummy, {
    fee: StellarSdk.BASE_FEE, networkPassphrase: NET,
  }).addOperation(op).setTimeout(30).build()
  const sim = await rpc.simulateTransaction(tx)
  return StellarSdk.scValToNative(sim.result.retval)
}

async function approveXlm(publicKey, stroops) {
  return sendTx(publicKey, new StellarSdk.Contract(XLM_TOKEN).call(
    'approve',
    StellarSdk.Address.fromString(publicKey).toScVal(),
    StellarSdk.Address.fromString(CONTRACT_ID).toScVal(),
    new StellarSdk.XdrLargeInt('i128', BigInt(stroops)).toI128(),
    StellarSdk.xdr.ScVal.scvU32(3_110_400),
  ))
}

const tc = () => new StellarSdk.Contract(CONTRACT_ID)

export async function submitGuess(player, word, guessFeeStoops) {
  await approveXlm(player, guessFeeStoops)
  const { hash, txResult } = await sendTxWithResult(player, tc().call(
    'guess',
    StellarSdk.Address.fromString(player).toScVal(),
    StellarSdk.xdr.ScVal.scvString(word.toLowerCase()),
  ))
  // Parse return value from transaction result
  let guessResult = null
  try {
    if (txResult?.returnValue) {
      guessResult = StellarSdk.scValToNative(txResult.returnValue)
    }
  } catch {}
  return { hash, guessResult }
}

export async function setNewRound(admin, word) {
  return sendTx(admin, tc().call(
    'new_round',
    StellarSdk.Address.fromString(admin).toScVal(),
    StellarSdk.xdr.ScVal.scvString(word.toLowerCase()),
  ))
}

export async function getConfig() {
  try { return await readContract(tc().call('get_config')) }
  catch { return null }
}

export async function getPlayerState(player, round) {
  try {
    return await readContract(tc().call(
      'get_player_state',
      StellarSdk.Address.fromString(player).toScVal(),
      StellarSdk.xdr.ScVal.scvU32(round),
    ))
  } catch { return null }
}

export const xlm   = s => (Number(s) / 10_000_000).toFixed(2)
export const short = a => a ? `${a.toString().slice(0,5)}…${a.toString().slice(-4)}` : '—'
export { CONTRACT_ID, ADMIN_ADDRESS }
