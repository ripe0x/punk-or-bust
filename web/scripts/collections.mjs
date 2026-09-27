// Fetches the list of whitelisted collections from the FWA pool and writes to web/src/data/collections.json
import { createPublicClient, http, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(web, 'src', 'data');

const FWA_POOL = '0x958C41181182e76F221331b2755b77D9e1426A98';
const START_BLOCK = 25944609n;
const RPC = 'https://mainnet.gateway.tenderly.co';

const client = createPublicClient({
  chain: mainnet,
  transport: http(RPC),
});

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
    collectionsList.push({
      address: getAddress(address), // Checksum the address
      name: name || getAddress(address), // Fallback to checksummed address if no name
    });
  }

  // Sort by name
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
