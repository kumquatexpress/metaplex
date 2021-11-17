#!/usr/bin/env ts-node
import * as fs from 'fs';
import * as path from 'path';
import { program } from 'commander';
import * as anchor from '@project-serum/anchor';
import fetch from 'node-fetch';

import {
  chunks,
  fromUTF8Array,
  parseDate,
  parsePrice,
} from './helpers/various';
import { Token, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import {
  CACHE_PATH,
  CONFIG_ARRAY_START,
  CONFIG_LINE_SIZE,
  EXTENSION_JSON,
  EXTENSION_PNG,
} from './helpers/constants';
import {
  getCandyMachineAddress,
  loadCandyProgram,
  loadWalletKey,
  createConfig,
} from './helpers/accounts';
import { Config } from './types';
import { upload } from './commands/upload';
import { verifyTokenMetadata } from './commands/verifyTokenMetadata';
import { generateConfigurations } from './commands/generateConfigurations';
import { loadCache, saveCache } from './helpers/cache';
import { mint } from './commands/mint';
import { signMetadata } from './commands/sign';
import { signAllMetadataFromCandyMachine } from './commands/signAll';
import log from 'loglevel';
import { createMetadataFiles } from './helpers/metadata';
import { createGenerativeArt } from './commands/createArt';
import { createCollectionConfig } from './helpers/toolbox/collections';

program.version('0.0.2');

if (!fs.existsSync(CACHE_PATH)) {
  fs.mkdirSync(CACHE_PATH);
}

log.setLevel(log.levels.INFO);

programCommand('create_collection_config').action(async (direction, cmd) => {
  const {
    keypair,
    env,
  } = cmd.opts();
  const walletKeyPair = loadWalletKey(keypair);
  const anchorProgram = await loadCandyProgram(walletKeyPair, env);
  createCollectionConfig(
    walletKeyPair,
    anchorProgram,
    {
      totalNFTs: 1,
      symbol: 'BOBO',
      sellerFeeBasisPoints: 0,
      isMutable: false,
      maxSupply: new anchor.BN(0),
      retainAuthority: false,
      creators: [{
        address: new PublicKey(walletKeyPair.publicKey.toBase58()),
        verified: true,
        share: 100,
      }],
    }
  )
});
// programCommand('test_candy')
//     .action(async(directory, cmd) => {
//         const keypair = '';
//         const env = '';
//         const price = '';
//         const solTreasuryAccount = '';

//         const walletKeyPair = loadWalletKey(keypair);
//         const anchorProgram = await loadCandyProgram(walletKeyPair, env);
//         let wallet = walletKeyPair.publicKey;
//         const remainingAccounts = [];

//         if (solTreasuryAccount) {
//             wallet = new PublicKey(solTreasuryAccount);
//           }

//           const config = new PublicKey(cacheContent.program.config);
//           const [candyMachine, bump] = await getCandyMachineAddress(
//             config,
//             cacheContent.program.uuid,
//           );
//           await anchorProgram.rpc.initializeCandyMachine(
//             bump,
//             {
//               uuid: cacheContent.program.uuid,
//               price: new anchor.BN(parsedPrice),
//               itemsAvailable: new anchor.BN(Object.keys(cacheContent.items).length),
//               goLiveDate: null,
//             },
//             {
//               accounts: {
//                 candyMachine,
//                 wallet,
//                 config: config,
//                 authority: walletKeyPair.publicKey,
//                 payer: walletKeyPair.publicKey,
//                 systemProgram: anchor.web3.SystemProgram.programId,
//                 rent: anchor.web3.SYSVAR_RENT_PUBKEY,
//               },
//               signers: [],
//               remainingAccounts,
//             },
//           );
//           cacheContent.candyMachineAddress = candyMachine.toBase58();
//           saveCache(cacheName, env, cacheContent);
//           log.info(
//             `create_candy_machine finished. candy machine pubkey: ${candyMachine.toBase58()}`,
//           );
//     })

programCommand('create_candy_machine')
  .option(
    '-p, --price <string>',
    'Price denominated in SOL or spl-token override',
    '1',
  )
  .option(
    '-t, --spl-token <string>',
    'SPL token used to price NFT mint. To use SOL leave this empty.',
  )
  .option(
    '-a, --spl-token-account <string>',
    'SPL token account that receives mint payments. Only required if spl-token is specified.',
  )
  .option(
    '-s, --sol-treasury-account <string>',
    'SOL account that receives mint payments.',
  )
  .option(
    '-r, --rpc-url <string>',
    'custom rpc url since this is a heavy command',
  )
  .action(async (directory, cmd) => {
    const {
      keypair,
      env,
      price,
      cacheName,
      splToken,
      splTokenAccount,
      solTreasuryAccount,
      rpcUrl,
    } = cmd.opts();

    let parsedPrice = parsePrice(price);
    const cacheContent = loadCache(cacheName, env);

    const walletKeyPair = loadWalletKey(keypair);
    const anchorProgram = await loadCandyProgram(walletKeyPair, env, rpcUrl);

    let wallet = walletKeyPair.publicKey;
    const remainingAccounts = [];
    if (splToken || splTokenAccount) {
      if (solTreasuryAccount) {
        throw new Error(
          'If spl-token-account or spl-token is set then sol-treasury-account cannot be set',
        );
      }
      if (!splToken) {
        throw new Error(
          'If spl-token-account is set, spl-token must also be set',
        );
      }
      const splTokenKey = new PublicKey(splToken);
      const splTokenAccountKey = new PublicKey(splTokenAccount);
      if (!splTokenAccount) {
        throw new Error(
          'If spl-token is set, spl-token-account must also be set',
        );
      }

      const token = new Token(
        anchorProgram.provider.connection,
        splTokenKey,
        TOKEN_PROGRAM_ID,
        walletKeyPair,
      );

      const mintInfo = await token.getMintInfo();
      if (!mintInfo.isInitialized) {
        throw new Error(`The specified spl-token is not initialized`);
      }
      const tokenAccount = await token.getAccountInfo(splTokenAccountKey);
      if (!tokenAccount.isInitialized) {
        throw new Error(`The specified spl-token-account is not initialized`);
      }
      if (!tokenAccount.mint.equals(splTokenKey)) {
        throw new Error(
          `The spl-token-account's mint (${tokenAccount.mint.toString()}) does not match specified spl-token ${splTokenKey.toString()}`,
        );
      }

      wallet = splTokenAccountKey;
      parsedPrice = parsePrice(price, 10 ** mintInfo.decimals);
      remainingAccounts.push({
        pubkey: splTokenKey,
        isWritable: false,
        isSigner: false,
      });
    }

    if (solTreasuryAccount) {
      wallet = new PublicKey(solTreasuryAccount);
    }

    const config = new PublicKey(cacheContent.program.config);
    const [candyMachine, bump] = await getCandyMachineAddress(
      config,
      cacheContent.program.uuid,
    );
    await anchorProgram.rpc.initializeCandyMachine(
      bump,
      {
        uuid: cacheContent.program.uuid,
        price: new anchor.BN(parsedPrice),
        itemsAvailable: new anchor.BN(Object.keys(cacheContent.items).length),
        goLiveDate: null,
      },
      {
        accounts: {
          candyMachine,
          wallet,
          config: config,
          authority: walletKeyPair.publicKey,
          payer: walletKeyPair.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [],
        remainingAccounts,
      },
    );
    cacheContent.candyMachineAddress = candyMachine.toBase58();
    saveCache(cacheName, env, cacheContent);
    log.info(
      `create_candy_machine finished. candy machine pubkey: ${candyMachine.toBase58()}`,
    );
  });

function programCommand(name: string) {
  return program
    .command(name)
    .option(
      '-e, --env <string>',
      'Solana cluster env name',
      'devnet', //mainnet-beta, testnet, devnet
    )
    .option(
      '-k, --keypair <path>',
      `Solana wallet location`,
      '--keypair not provided',
    )
    .option('-l, --log-level <string>', 'log level', setLogLevel)
    .option('-c, --cache-name <string>', 'Cache file name', 'temp');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function setLogLevel(value, prev) {
  if (value === undefined || value === null) {
    return;
  }
  log.info('setting the log value to: ' + value);
  log.setLevel(value);
}

program.parse(process.argv);
