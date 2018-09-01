import {networks, HDNode, Transaction, TransactionBuilder, crypto, script} from 'bitcoinjs-lib-zcash';
import bip39 from 'bip39';
import {WorkerDiscovery} from 'hd-wallet';
import {BitcoreBlockchain} from 'hd-wallet';

// we cannot use hd-wallet directly, since that is tailored to trezor
// we need to use the low-level coinselect lib in hd-wallet
import split from './node_modules/hd-wallet/lib/build-tx/coinselect-lib/outputs/split.js';

const socketWorkerFactory = () => new Worker('./socket-worker.js');
const discoveryWorkerFactory = () => new Worker('./discovery-worker.js');
// setting up workers
const fastXpubWorker = new Worker('fastxpub.js');
const fastXpubWasmFilePromise = fetch('fastxpub.wasm')
    .then(response => response.ok ? response.arrayBuffer() : Promise.reject('failed to load'));

const seed_el = document.getElementById("seed");
const passphrase_el = document.getElementById("passphrase");
const getbalance = document.getElementById("getbalance");
const balance_el = document.getElementById("balance");
const address_el = document.getElementById("address");
const labeladdress_el = document.getElementById("labeladdress");
const sendtx = document.getElementById("sendtx");
const result_el = document.getElementById("result");

const urls = ['https://karelchain.com'];
const blockchain = new BitcoreBlockchain(urls, socketWorkerFactory);
const discovery = new WorkerDiscovery(discoveryWorkerFactory, fastXpubWorker, fastXpubWasmFilePromise, blockchain);
const network = networks.bitcoin;

let utxos = [];
let maxTx = {};

getbalance.onclick = async () => {
  address_el.style.display = 'none';
  labeladdress_el.style.display = 'none';
  sendtx.style.display = 'none';

  const valid = bip39.validateMnemonic(seed_el.value)
  if (!valid) {
    balance_el.innerText = "Your seed is invalid"
  } else {
    const seed = bip39.mnemonicToSeed(seed_el.value, passphrase_el.value)
    const node = HDNode.fromSeedBuffer(seed)
    balance_el.innerText = "Calculating balance, please wait!"

    // first look for utxos
    const segwitNode = node.derivePath("m/49'/0'")
    const legacyNode = node.derivePath("m/44'/0'")
    
    utxos = [];
    let cont = true;
    let i = 0;
    let height = 0;
    while (cont) {
      const info = await discoverAccount(legacyNode, i, discovery, network, false);
      if (info.transactions.length == 0) {
        cont = false;
      }
      utxos.push(...info.utxos);
      i++;
      height = info.lastBlock.height;
    }
    cont = true;
    i = 0;
    while (cont) {
      const info = await discoverAccount(segwitNode, i, discovery, network, true);
      if (info.transactions.length == 0) {
        cont = false;
      }
      utxos.push(...info.utxos);
      i++;
    }

    // bip69 input sort (no sort of output, just 1)
    utxos.sort((a, b) => utxoComparator(a,b));

    // get fee, 3 blocks, conservative
    const afee = await blockchain.estimateSmartTxFees([3], true);
    const fee = afee[3]
    
    // find sendable balance
    // (note - it is always using all inputs, even when it is negative)
    //
    // we cannot use hd-wallet directly, since that is tailored to trezor
    // we need to use the low-level coinselect lib in hd-wallet
    const allCoinselectInputs = [];
    for (const u of utxos) {
      const coinselectInput = convertInput(u, height);
      allCoinselectInputs.push(coinselectInput)
    }

    const options = {
      inputLength: 109,
      changeOutputLength: 25,
      dustThreshold: 546
    };

    maxTx = split(allCoinselectInputs, [{script: {length: 25}}], Math.ceil(fee * 1e5), options);
    if (maxTx.outputs == null) {
      balance_el.innerText = "Sorry, you don't have anything on the seed.";
    } else {
      const btcBalance = maxTx.outputs[0].value / 10e8;
      balance_el.innerText = "Can send: " + btcBalance + " BTC (with 3 block fee)";
      address_el.style.display = 'block';
      labeladdress_el.style.display = 'block';
      sendtx.style.display = 'block';
    }
  }
};

sendtx.onclick = async() => {
  try {
    const id = await sendOnClick();
    balance_el.innerText = "";
    // btc.com is the only good explorer
    result_el.innerHTML="<a href='https://btc.com/" + id + "'i target='_blank' rel='noopener noreferrer'>Transaction sent!</a>";
  } catch (e) {
    balance_el.innerText = "";
    result_el.innerText = "Error " + JSON.stringify(e) + " - " + JSON.stringify(e.message);
    console.error(e);
  }
}

async function sendOnClick() {
  // make tx
  const builder = new TransactionBuilder();
  for (const u of utxos) {
    if (u.segwit) {
      builder.addInput(reverseEndian(u.transactionHash), u.index, 0xffffffff, u.scriptPubKey)
    } else {
      builder.addInput(reverseEndian(u.transactionHash), u.index)
    }
  }
  builder.addOutput(address_el.value, maxTx.outputs[0].value)
  let j = 0;
  for (const u of utxos) {
    if (u.segwit) {
      builder.sign(j, u.keyPair, u.redeemScript, null, u.value)
    } else {
      builder.sign(j, u.keyPair)
    }
    j++;
  }
  const tx = builder.build().toHex()
  const id = await blockchain.sendTransaction(tx);
  return id;
}

async function discoverAccount(node, i, discovery, network, segwit) {
    const privnode = node.derivePath(i + "'");
    const xpub = privnode.neutered().toBase58();
    console.log(xpub)

    const process = discovery.discoverAccount(null, xpub, network, segwit ? 'p2sh' : 'off', false, 20, new Date().getTimezoneOffset());
    
    process.stream.values.attach(status => { 
      const startText = segwit ? "Segwit account #" : "Legacy account #";
      balance_el.innerText = startText + (i+1) + ", " + status.transactions + " transactions";
    });
    const account = await process.ending;
    for (const u of account.utxos) {
      const keyPair = privnode.derive(u.addressPath[0]).derive(u.addressPath[1]).keyPair
      u.keyPair = keyPair
      if (segwit) {
        // we will need all this magic for p2wpkh-inside-p2sh
        const pubKey = keyPair.getPublicKeyBuffer()
        const pubKeyHash = crypto.hash160(pubKey)
        const redeemScript = script.witnessPubKeyHash.output.encode(pubKeyHash)
        const redeemScriptHash = crypto.hash160(redeemScript)

        const scriptPubKey = script.scriptHash.output.encode(redeemScriptHash)
        u.scriptPubKey = scriptPubKey;
        u.redeemScript = redeemScript;
      }
      u.segwit = segwit;
    }
    return account;
}

// we cannot use hd-wallet directly, since that is tailored to trezor
// we need to use the low-level coinselect lib in hd-wallet
const SEGWIT_INPUT_SCRIPT_LENGTH = 51;
const INPUT_SCRIPT_LENGTH = 109;

function convertInput(
    input,
    height
) {
    const segwit = input.segwit;
    const bytesPerInput = segwit ? SEGWIT_INPUT_SCRIPT_LENGTH : INPUT_SCRIPT_LENGTH;
    return {
        script: {length: bytesPerInput},
        value: input.value,
        own: input.own,
        coinbase: input.coinbase,
        confirmations: input.height == null
            ? 0
            : (1 + height - input.height),
    };
}

function utxoComparator(a, b) {
    const aHash = new Buffer(a.transactionHash)
    const aVout = a.index
    const bHash = new Buffer(b.transactionHash)
    const bVout = b.index

    return aHash.compare(bHash) || (aVout - bVout);
}

function reverseEndian(t) {
    const src = new Buffer(t, 'hex');
    const buffer = new Buffer(src.length);
    for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
        buffer[i] = src[j];
        buffer[j] = src[i];
    }
    return t;
//    return buffer.toString('hex');
}
