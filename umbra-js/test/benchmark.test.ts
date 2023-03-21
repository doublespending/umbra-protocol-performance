import { ethers } from 'hardhat';
import { hexZeroPad, isHexString, sha256, BigNumber } from '../src/ethers';
import hardhatConfig from '../hardhat.config';
import { Umbra } from '../src/classes/Umbra';
import { Wallet } from '../src/ethers';
import { KeyPair } from '../src/classes/KeyPair';
import { HardhatNetworkHDAccountsUserConfig } from 'hardhat/src/types/config';
import type { ChainConfig, Announcement } from '../src/types';
import { getSharedSecret as nobleGetSharedSecret, utils as nobleUtils } from '@noble/secp256k1';
import { assertValidPoint, assertValidPrivateKey, lengths } from '../src/utils/utils';

const ethersProvider = ethers.provider;

// We don't use the 0 or 1 index just to reduce the chance of conflicting with a signer for another use case
const receiverIndex = 3;

function getSharedSecret(privateKey: string, publicKey: string) {
  if (privateKey.length !== lengths.privateKey || !isHexString(privateKey)) throw new Error('Invalid private key');
  if (publicKey.length !== lengths.publicKey || !isHexString(publicKey)) throw new Error('Invalid public key');
  assertValidPoint(publicKey);
  assertValidPrivateKey(privateKey);

  // We use sharedSecret.slice(2) to ensure the shared secret is not dependent on the prefix, which enables
  // us to uncompress ephemeralPublicKey from Umbra.sol logs as explained in comments of getUncompressedFromX.
  // Note that a shared secret is really just a point on the curve, so it's an uncompressed public key
  const sharedSecret = nobleGetSharedSecret(privateKey.slice(2), publicKey.slice(2), true);
  const sharedSecretHex = nobleUtils.bytesToHex(sharedSecret); // Has 04 prefix but not 0x.
  return sha256(`0x${sharedSecretHex.slice(2)}`); // TODO Update to use noble-hashes?
}

describe.only('Scan Performance', () => {
  let receiver: Wallet;

  let umbra: Umbra;
  let chainConfig: ChainConfig;

  before(async () => {
    // Load signers' mnemonic and derivation path from hardhat config
    const accounts = hardhatConfig.networks?.hardhat?.accounts as HardhatNetworkHDAccountsUserConfig;
    const { mnemonic, path } = accounts;

    // Get the wallets of interest. The hardhat signers are generated by appending "/index" to the derivation path,
    // so we do the same to instantiate our wallets. Private key can now be accessed by `sender.privateKey`
    receiver = ethers.Wallet.fromMnemonic(mnemonic as string, `${path as string}/${receiverIndex}`);
    receiver.connect(ethers.provider);

    const lastBlockNumber = await ethersProvider.getBlockNumber();
    // Load other signers
    chainConfig = {
      chainId: 1337, // polygon
      umbraAddress: '0xFb2dc580Eed955B528407b4d36FfaFe3da685401',
      startBlock: lastBlockNumber,
      subgraphUrl: 'https://api.thegraph.com/subgraphs/name/scopelift/umbrapolygon',
    };
    console.log(chainConfig);
    // Get Umbra instance
    umbra = new Umbra(ethersProvider, chainConfig);
  });

  describe('fetchAllAnnouncements', () => {
    it('fetchAllAnnouncements from subgraph', async () => {
      const t1 = Date.now();
      const a1 = await umbra.fetchAllAnnouncements({
        startBlock: 8686346,
        endBlock: 8686346,
      });
      const t2 = Date.now();
      const a2 = await umbra.fetchAllAnnouncements({
        startBlock: 8686346,
        endBlock: 8686446,
      });
      const t3 = Date.now();
      console.log('fetch 1 block from subgraph:', t2 - t1, 'ms with', a1.length, 'announcements');
      console.log('fetch 100 blocks from subgraph:', t3 - t2, 'ms with', a2.length, 'announcements');
    });
    it('fetchAllAnnouncements from node', async () => {
      chainConfig.subgraphUrl = '';
      const t1 = Date.now();
      const a1 = await umbra.fetchAllAnnouncements({
        startBlock: 8686346,
        endBlock: 8686346,
      });
      const t2 = Date.now();
      const a2 = await umbra.fetchAllAnnouncements({
        startBlock: 8686346,
        endBlock: 8686446,
      });
      const t3 = Date.now();
      console.log('fetch 1 block from node:', t2 - t1, 'ms', a1.length, 'announcements');
      console.log('fetch 100 blocks from node:', t3 - t2, 'ms with', a2.length, 'announcements');
    });
  });

  describe('isAnnouncementForUser', () => {
    let announcements: Announcement[];
    beforeEach(async () => {
      announcements = await umbra.fetchAllAnnouncements({
        startBlock: 8686346,
        endBlock: 8686446,
      });
    });
    it('isAnnouncementForUser', async () => {
      const totalTime = announcements.reduce(
        (totalTime, ann) => {
          const t1 = Date.now();
          // Get y-coordinate of public key from the x-coordinate by solving secp256k1 equation
          const { pkx, ciphertext } = ann;
          const ephemeralPublicKey = KeyPair.getUncompressedFromX(pkx);
          const t2 = Date.now();
          // Decrypt to get random number
          const viewingKeyPair = new KeyPair(receiver.privateKey);
          if (!ephemeralPublicKey || !ciphertext) {
            throw new Error('Input must be of type EncryptedPayload to decrypt');
          }
          if (!viewingKeyPair.privateKeyHex) {
            throw new Error('KeyPair has no associated private key to decrypt with');
          }
          assertValidPoint(ephemeralPublicKey); // throw if point is not on curve

          // Get shared secret to use as decryption key, then decrypt with XOR
          const sharedSecret = getSharedSecret(viewingKeyPair.privateKeyHex, ephemeralPublicKey);
          const t3 = Date.now();
          sha256(sharedSecret);
          const t4 = Date.now();
          const plaintext = BigNumber.from(ciphertext).xor(sharedSecret);
          const randomNumber = hexZeroPad(plaintext.toHexString(), 32);
          const t5 = Date.now();
          // Get what our receiving address would be with this random number
          const spendingKeyPair = new KeyPair(receiver.publicKey);
          // computedReceivingAddress
          spendingKeyPair.mulPublicKey(randomNumber).address;
          const t6 = Date.now();
          totalTime[0] += t2 - t1;
          totalTime[1] += t3 - t2;
          totalTime[2] += t4 - t3;
          totalTime[3] += t5 - t4;
          totalTime[4] += t6 - t5;
          totalTime[5] += t4 - t1; // tag checked
          totalTime[6] += t6 - t1 - (t4 - t3); // time cost without tag
          return totalTime;
        },
        [0, 0, 0, 0, 0, 0, 0]
      );
      const averageTime = totalTime.map((t) => t / announcements.length);
      console.log('scan performance (ms):', JSON.stringify(averageTime));
    });
  });
});
