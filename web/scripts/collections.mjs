// Fetches the list of whitelisted collections from the FWA pool and writes to web/src/data/collections.json
import { createPublicClient, http, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Display names where the contract name() differs from the name people know.
const NAME_OVERRIDES = {
  "0x0427743df720801825a5c82e0582b1e915e0f750": "0xmons",
  "0xd92e44ac213b9ebda0178e1523cc0ce177b7fa96": "BEEPLE: EVERYDAYS - THE 2020 COLLECTION",
  "0xdd012153e008346591153fff28b0dd6724f0c256": "BEEPLE - SPRING/SUMMER COLLECTION 2021",
  "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d": "Bored Ape Yacht Club",
  "0xd90829c6c6012e4dde506bd95d7499a04b9a56de": "The Broken Keys",
  "0x036721e5a769cc48b3189efbb9cce4471e8a48b1": "Checks - VV Originals",
  "0x1cb1a5e65610aeff2551a50f76a87a7d3fb649c6": "CrypToadz by GREMPLIN",
  "0x42069abfe407c60cf4ae4112bedead391dba1cdb": "CryptoDickbutts",
  "0x000000000000003607fce1ac9e043a86675c5c2f": "CryptoPunks",
  "0x2acab3dea77832c09420663b0e1cb386031ba17b": "Deadfellaz",
  "0x880af717abba38f31ca21673843636a355fb45f3": "DRIP DROP BY DAVE KRUGMAN",
  "0x4024c2083f5457874ec489f7c7332680bb86c92b": "Wolf Game Farmers",
  "0x29f1cbc8eccd64b0ce777f5da45c72c47383a620": "FWAIR PFP",
  "0x0000ec93127baa929e58e97dd0095a2bfb38ec1d": "Identity MD",
  "0xe012baf811cf9c05c408e879c399960d1f305903": "Otherside Koda",
  "0x614917f589593189ac27ac8b81064cbe450c35e3": "Letters by Vinnie Hager",
  "0x524cab2ec69124574082676e6f654a18df49a048": "Lil Pudgys",
  "0xff9c1b15b16263c61d017ee9f65c50e4ae0113d7": "Loot (for Adventurers)",
  "0xd1169e5349d1cb9941f3dcba135c8a4b9eacfdde": "MAX PAIN AND FRENS",
  "0x79fcdef22feed20eddacbb2587640e45491b757f": "mfers",
  "0x5af0d9827e0c53e4799bb226655a1de152a425a5": "Milady Maker",
  "0x60e4d786628fea6478f785a6d7e704777c86a7c6": "Mutant Ape Yacht Club",
  "0xbd3531da5cf5857e7cfaa92426877b022e612cf8": "Pudgy Penguins",
  "0x062e691c2054de82f28008a8ccc6d7a1c8ce060d": "Pudgy Rods",
  "0xd16809c0a7d82c9e7552a01fd608fff90efb564f": "Right Click Share",
  "0xb852c6b5892256c264cc2c888ea462189154d8d7": "rektguy",
  "0xdfea2b364db868b1d2601d6b833d74db4de94460": "REMNANTS",
  "0xc04e0000726ed7c5b9f0045bc0c4806321bc6c65": "ICXN",
  "0x6efc003d3f3658383f06185503340c2cf27a57b6": "Memeland MVP"
};

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(web, 'src', 'data');

const FWA_POOL = '0x958C41181182e76F221331b2755b77D9e1426A98';
const START_BLOCK = 25944609n;
const RPC = 'https://mainnet.gateway.tenderly.co';

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC),
});

const IPFS_GATEWAYS = [
  'https://ipfs.filebase.io/ipfs/',
  'https://dweb.link/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://nftstorage.link/ipfs/',
];
const SAMPLE_IDS = [1n, 0n, 2n, 10n];
const MAX_DATA_IMAGE = 20 * 1024;
const PUNKS_721 = '0x000000000000003607fce1ac9e043a86675c5c2f';
const tokenUriAbi = [
  { type: 'function', name: 'tokenURI', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }], stateMutability: 'view' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// GET a URL with retry/backoff on 429 and transient errors; returns parsed JSON or null.
async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url);
      if (res.status === 429) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return null;
      return JSON.parse(await res.text());
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

function parseDataJson(uri) {
  const m = /^data:([^,]*?),(.*)$/s.exec(uri);
  if (!m) return null;
  try {
    const body = /;base64/i.test(m[1]) ? Buffer.from(m[2], 'base64').toString('utf8') : decodeURIComponent(m[2]);
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function loadMetadata(uri) {
  uri = uri.trim();
  if (uri.startsWith('data:')) return parseDataJson(uri);
  if (uri.startsWith('ar://')) return fetchJson(`https://arweave.net/${uri.slice(5)}`);
  if (uri.startsWith('ipfs://')) {
    const path = uri.slice(7).replace(/^ipfs\//, '');
    for (const gw of IPFS_GATEWAYS) {
      const json = await fetchJson(gw + path);
      if (json) return json;
    }
    return null;
  }
  if (/^https?:\/\//.test(uri)) return fetchJson(uri);
  return null;
}

async function sampleImage(address) {
  let uri = null;
  for (const id of SAMPLE_IDS) {
    try {
      uri = await client.readContract({ address, abi: tokenUriAbi, functionName: 'tokenURI', args: [id] });
      if (uri) break;
    } catch {
      // try next id
    }
  }
  if (!uri) return null;
  const meta = await loadMetadata(uri);
  const image = meta && (meta.image ?? meta.image_url);
  if (typeof image !== 'string' || !image) return null;
  if (image.startsWith('data:') && image.length > MAX_DATA_IMAGE) return null;
  return image;
}

async function fetchCollections() {
  console.log('Fetching CollectionWhitelistSet logs...');

  // First, get the latest block
  const latestBlock = await client.getBlockNumber();
  console.log(`Latest block: ${latestBlock}`);

  // Fetch logs in one call; if it errors, fall back to chunking
  let logs = [];
  try {
    logs = await client.getLogs({
      address: FWA_POOL,
      event: {
        type: 'event',
        name: 'CollectionWhitelistSet',
        inputs: [
          { type: 'address', name: 'collection', indexed: true },
          { type: 'bool', name: 'allowed', indexed: false },
        ],
      },
      fromBlock: START_BLOCK,
      toBlock: latestBlock,
    });
    console.log(`Fetched ${logs.length} logs in one call`);
  } catch (e) {
    console.log('Single call failed, chunking in 50k-block increments...');
    const chunkSize = 50_000n;
    for (let from = START_BLOCK; from <= latestBlock; from += chunkSize) {
      const to = from + chunkSize - 1n > latestBlock ? latestBlock : from + chunkSize - 1n;
      const chunkLogs = await client.getLogs({
        address: FWA_POOL,
        event: {
          type: 'event',
          name: 'CollectionWhitelistSet',
          inputs: [
            { type: 'address', name: 'collection', indexed: true },
            { type: 'bool', name: 'allowed', indexed: false },
          ],
        },
        fromBlock: from,
        toBlock: to,
      });
      logs = logs.concat(chunkLogs);
      console.log(`Fetched ${chunkLogs.length} logs for blocks ${from}-${to}`);
    }
  }

  // Replay logs to determine final state
  const collections = new Map(); // address -> bool
  for (const log of logs) {
    if (log.args && log.args.collection && log.args.allowed !== undefined) {
      collections.set(log.args.collection.toLowerCase(), log.args.allowed);
    }
  }

  // Filter to only allowed collections
  const allowedAddresses = Array.from(collections.entries())
    .filter(([_, allowed]) => allowed)
    .map(([address, _]) => address);

  console.log(`Found ${allowedAddresses.length} allowed collections`);

  // Fetch names via batch call
  console.log('Fetching names...');
  const collectionsList = [];
  for (const address of allowedAddresses) {
    let name = null;
    try {
      name = await client.readContract({
        address,
        abi: [
          {
            type: 'function',
            name: 'name',
            inputs: [],
            outputs: [{ type: 'string' }],
            stateMutability: 'view',
          },
        ],
        functionName: 'name',
      });
    } catch (e) {
      // Fallback to address if name() fails
    }
    const entry = {
      address: getAddress(address), // Checksum the address
      name: NAME_OVERRIDES[address.toLowerCase()] ?? (name || getAddress(address)),
    };
    if (address.toLowerCase() !== PUNKS_721) {
      const image = await sampleImage(address).catch(() => null);
      if (image) entry.image = image;
      console.log(`${entry.name}: ${image ? image.slice(0, 60) : 'no image'}`);
      await sleep(250);
    }
    collectionsList.push(entry);
  }

  // Sort by name, case-insensitive
  collectionsList.sort((a, b) => a.name.localeCompare(b.name));

  // Write to file
  mkdirSync(dataDir, { recursive: true });
  const output = JSON.stringify(collectionsList, null, 2) + '\n';
  writeFileSync(join(dataDir, 'collections.json'), output);

  console.log(`Wrote ${collectionsList.length} collections to web/src/data/collections.json`);
  console.log('Sample:');
  console.log(JSON.stringify(collectionsList.slice(0, 3), null, 2));
}

fetchCollections().catch(console.error);
