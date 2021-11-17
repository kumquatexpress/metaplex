import * as anchor from '@project-serum/anchor';
import path from 'path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { createConfig } from '../accounts';
import { EXTENSION_PNG } from '../constants';
import log from 'loglevel';
import fs from 'fs';
import { awsUpload } from '../upload/aws';
import { arweaveUpload } from '../upload/arweave';
import { ipfsCreds, ipfsUpload } from '../upload/ipfs';
import { chunks } from '../various';
import { NFTManifest } from './types';

export interface CollectionConfig {
  program: {
    uuid: string;
    config: string;
  };
  config: PublicKey;
  authority: string;
}

export interface UploadResult {
  link: string;
  name: string;
  onChain: boolean;
}

export async function createCollectionConfig(
  keypair: Keypair,
  program: anchor.Program,
  args: {
    totalNFTs: number;
    symbol: string;
    sellerFeeBasisPoints: number;
    isMutable: boolean;
    maxSupply: anchor.BN;
    retainAuthority: boolean;
    creators: {
      address: PublicKey;
      verified: boolean;
      share: number;
    }[];
  },
): Promise<CollectionConfig> {
  log.info(`createCollectionConfig: `, args);
  try {
    const res = await createConfig(program, keypair, {
      maxNumberOfLines: new anchor.BN(args.totalNFTs),
      symbol: args.symbol,
      sellerFeeBasisPoints: args.sellerFeeBasisPoints,
      isMutable: args.isMutable,
      maxSupply: args.maxSupply,
      retainAuthority: args.retainAuthority,
      creators: args.creators.map(creator => {
        return {
          address: new PublicKey(creator.address),
          verified: true,
          share: creator.share,
        };
      }),
    });

    log.info(
      'createCollectionConfig: initialized config for a candy machine with publickey ',
      res.config.toBase58(),
    );
    return {
      program: {
        uuid: res.uuid,
        config: res.config.toBase58(),
      },
      config: res.config,
      authority: keypair.publicKey.toBase58(),
    };
  } catch (exx) {
    log.error(
      'createCollectionConfig: Error deploying config to Solana network.',
      exx,
    );
    throw exx;
  }
}

export async function uploadToIPFS(
  keypair: Keypair,
  program: anchor.Program,
  env: string,
  imagePath: string,
  storageArgs: {
    storage: 'arweave' | 'ipfs' | 'aws';
    ipfsCredentials?: ipfsCreds;
    awsS3Bucket?: string;
  },
): Promise<UploadResult> {
  log.info('uploadToIPFS: ', storageArgs);
  try {
    const manifest = createManifestForImage(imagePath);
    const manifestBuffer = Buffer.from(JSON.stringify(manifest));

    let link;
    if (storageArgs.storage === 'arweave') {
      link = await arweaveUpload(
        keypair,
        program,
        env,
        imagePath,
        manifestBuffer,
        manifest,
        undefined,
      );
    } else if (storageArgs.storage === 'ipfs') {
      link = await ipfsUpload(
        storageArgs.ipfsCredentials,
        imagePath,
        manifestBuffer,
      );
    } else if (storageArgs.storage === 'aws') {
      link = await awsUpload(
        storageArgs.awsS3Bucket,
        imagePath,
        manifestBuffer,
      );
    }
    if (link) {
      return {
        link,
        name: manifest.name,
        onChain: false,
      };
    }
  } catch (er) {
    log.error('uploadToIPFS: ', er);
  }
}

export function createManifestForImage(imagePath: string): NFTManifest {
  const imageName = path.basename(imagePath);
  const manifestPath = imagePath.replace(EXTENSION_PNG, '.json');
  const manifestContent = fs
    .readFileSync(manifestPath)
    .toString()
    .replace(imageName, 'image.png');

  return JSON.parse(manifestContent);
}

export async function addLinksToCollection(
  keypair: Keypair,
  program: anchor.Program,
  collectionConfig: CollectionConfig,
  items: UploadResult[],
) {
  log.info('addLinksToCollection: ', items);
  const keys = Object.keys(items);
  await Promise.all(
    chunks(Array.from(Array(keys.length).keys()), 1000).map(
      async allIndexesInSlice => {
        for (let offset = 0; offset < allIndexesInSlice.length; offset += 10) {
          const indexes = allIndexesInSlice.slice(offset, offset + 10);
          const onChain = indexes.filter(i => {
            const index = keys[i];
            return items[index]?.onChain || false;
          });
          const ind = keys[indexes[0]];

          if (onChain.length != indexes.length) {
            log.info(
              `addLinksToCollection: Writing indices ${ind}-${
                keys[indexes[indexes.length - 1]]
              }`,
            );
            try {
              await program.rpc.addConfigLines(
                ind,
                indexes.map(i => ({
                  uri: items[keys[i]].link,
                  name: items[keys[i]].name,
                })),
                {
                  accounts: {
                    config: collectionConfig,
                    authority: keypair.publicKey,
                  },
                  signers: [keypair],
                },
              );
              indexes.forEach(i => {
                items[keys[i]] = {
                  ...items[keys[i]],
                  onChain: true,
                };
              });
            } catch (e) {
              log.error(
                `addLinksToCollection: saving config line ${ind}-${
                  keys[indexes[indexes.length - 1]]
                } failed`,
                e,
              );
            }
          }
        }
      },
    ),
  );
}
