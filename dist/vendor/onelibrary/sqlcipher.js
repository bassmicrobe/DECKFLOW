// Adapted from v1vendi/onelibrary (MIT). See LICENSE and NOTICE.md.
/**
 * SQLCipher 4 encryption/decryption in the browser, using WebCrypto only.
 *
 * rekordbox writes `exportLibrary.db` with SQLCipher 4 defaults:
 *
 *   page size  4096
 *   reserve    80 bytes per page = 16-byte IV + 64-byte HMAC-SHA512
 *   KDF        PBKDF2-HMAC-SHA512, 256000 iterations, 32-byte key
 *   cipher     AES-256-CBC, no padding
 *
 * Page 1 opens with a 16-byte plaintext salt, which is the KDF salt for the
 * whole database. Its ciphertext therefore starts at offset 16 and is 16 bytes
 * shorter than every other page.
 *
 * Layout, per 4096-byte page:
 *
 *   page 1   [salt 16][ciphertext 4000][IV 16][HMAC 64]
 *   page n   [ciphertext 4016        ][IV 16][HMAC 64]
 *
 * The parameters are self-validating: byte 16 of the decrypted first page is
 * the SQLite page-size field and byte 20 is the reserve field, so a correct
 * decryption reports back exactly the values used to perform it. `decrypt()`
 * checks this and throws otherwise, which also makes a wrong passphrase fail
 * loudly instead of yielding noise.
 */

export const PAGE_SIZE = 4096;
export const RESERVE = 80;
export const IV_LEN = 16;
export const SALT_LEN = 16;
export const KDF_ITERATIONS = 256000;

/** The passphrase rekordbox uses for exportLibrary.db. */
export const MASTER_KEY = '402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497';
export const DEFAULT_KEY =
  'r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls';

export class DecryptError extends Error {}

/**
 * AES-CBC without padding.
 *
 * WebCrypto always applies PKCS#7 and rejects ciphertext that does not end in
 * valid padding, but SQLCipher pages are raw CBC. Encrypting an empty buffer
 * under the final ciphertext block as IV produces exactly one block of valid
 * padding; appending it lets `decrypt()` succeed and strip that block, leaving
 * the true plaintext.
 */
async function decryptNoPadding(key, iv, ciphertext) {
  const lastBlock = ciphertext.subarray(ciphertext.length - 16);
  const padBlock = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastBlock }, key, new Uint8Array(0))
  );
  const joined = new Uint8Array(ciphertext.length + padBlock.length);
  joined.set(ciphertext);
  joined.set(padBlock, ciphertext.length);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, joined)
  );
}

/** Derive the 256-bit page key from a passphrase and the database salt. */
async function deriveKeys(passphrase, salt) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-512' }, base, 256
  );
  const aes = await crypto.subtle.importKey('raw', bits, 'AES-CBC', false, ['encrypt', 'decrypt']);
  const macSalt = Uint8Array.from(salt, byte => byte ^ 0x3a);
  const macBase = await crypto.subtle.importKey('raw', bits, 'PBKDF2', false, ['deriveBits']);
  const macBits = await crypto.subtle.deriveBits({name:'PBKDF2', salt:macSalt, iterations:2, hash:'SHA-512'}, macBase, 256);
  const mac = await crypto.subtle.importKey('raw', macBits, {name:'HMAC', hash:'SHA-512'}, false, ['verify','sign']);
  return {aes, mac};
}

/**
 * Decrypt a whole SQLCipher database into a plain SQLite image.
 *
 * @param {ArrayBuffer|Uint8Array} buffer  the raw exportLibrary.db bytes
 * @param {string} passphrase
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<Uint8Array>} a standard SQLite file
 */
export async function decrypt(buffer, passphrase = DEFAULT_KEY, onProgress, {signal} = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (data.length > 128 * 1024 * 1024) throw new DecryptError('database exceeds 128 MiB');
  if (data.length < PAGE_SIZE) throw new DecryptError('file is too small to be a database');
  if (data.length % PAGE_SIZE !== 0) {
    throw new DecryptError(`file is not a whole number of ${PAGE_SIZE}-byte pages`);
  }

  const salt = data.subarray(0, SALT_LEN);
  const {aes:key, mac} = await deriveKeys(passphrase, salt);
  const pageCount = data.length / PAGE_SIZE;
  const out = new Uint8Array(data.length);

  // A SQLite image must start with this, which SQLCipher overwrote with salt.
  out.set(new TextEncoder().encode('SQLite format 3\0'), 0);

  for (let i = 0; i < pageCount; i++) {
    signal?.throwIfAborted();
    const start = i * PAGE_SIZE;
    const bodyStart = i === 0 ? start + SALT_LEN : start;
    const ctEnd = start + PAGE_SIZE - RESERVE;
    const ct = data.subarray(bodyStart, ctEnd);
    const iv = data.subarray(ctEnd, ctEnd + IV_LEN);

    // Verify before decrypting. Header plausibility alone cannot detect changed pages.
    const macInput = new Uint8Array(ct.length + IV_LEN + 4);
    macInput.set(ct); macInput.set(iv, ct.length);
    new DataView(macInput.buffer).setUint32(macInput.length - 4, i + 1, true);
    if (!await crypto.subtle.verify('HMAC', mac, data.subarray(ctEnd + IV_LEN, start + PAGE_SIZE), macInput)) {
      throw new DecryptError(`page ${i + 1} authentication failed: wrong key or damaged database`);
    }
    let plain;
    try {
      plain = await decryptNoPadding(key, iv, ct);
    } catch (err) {
      throw new DecryptError(
        `page ${i + 1} failed to decrypt - wrong passphrase, or not a SQLCipher database`
      );
    }
    out.set(plain, bodyStart);
    // Keep the reserve area zeroed; SQLite ignores it once reserve is declared.
    if (onProgress && (i % 64 === 0 || i === pageCount - 1)) onProgress(i + 1, pageCount);
  }

  // Self-check: the header we just decrypted must describe the geometry we used.
  const view = new DataView(out.buffer);
  const declaredPageSize = view.getUint16(16);
  const declaredReserve = view.getUint8(20);
  if (declaredPageSize !== PAGE_SIZE || declaredReserve !== RESERVE) {
    throw new DecryptError(
      `decryption produced an invalid header (page size ${declaredPageSize}, ` +
      `reserve ${declaredReserve}) - the passphrase is probably wrong`
    );
  }
  return out;
}

/** SQLCipher 4 encryption of a SQLite-engine-written image. Reserved bytes
 * must already exist in every page; inserting them into a normal SQLite file
 * would corrupt its cell offsets. Salt and each page IV are freshly random. */
export async function encrypt(buffer, passphrase = DEFAULT_KEY, onProgress, {signal} = {}) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  signal?.throwIfAborted();
  if (data.length < PAGE_SIZE || data.length > 128 * 1024 * 1024 || data.length % PAGE_SIZE ||
      new TextDecoder().decode(data.subarray(0,16)) !== 'SQLite format 3\0' ||
      new DataView(data.buffer,data.byteOffset,data.byteLength).getUint16(16) !== PAGE_SIZE || data[20] !== RESERVE) {
    throw new DecryptError('encryption requires a 4096-byte SQLite image with 80 reserved bytes per page');
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const {aes,mac} = await deriveKeys(passphrase,salt);
  const out = new Uint8Array(data.length); out.set(salt);
  const count = data.length / PAGE_SIZE;
  for (let i=0;i<count;i++) {
    signal?.throwIfAborted();
    const start=i*PAGE_SIZE, body=start+(i===0?SALT_LEN:0), end=start+PAGE_SIZE-RESERVE;
    const iv=crypto.getRandomValues(new Uint8Array(IV_LEN));
    // WebCrypto appends one PKCS#7 block. All useful plaintext is block aligned.
    const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv},aes,data.subarray(body,end))).subarray(0,end-body);
    out.set(ciphertext,body); out.set(iv,end);
    const authenticated=new Uint8Array(ciphertext.length+IV_LEN+4);
    authenticated.set(ciphertext); authenticated.set(iv,ciphertext.length);
    new DataView(authenticated.buffer).setUint32(authenticated.length-4,i+1,true);
    out.set(new Uint8Array(await crypto.subtle.sign('HMAC',mac,authenticated)),end+IV_LEN);
    if (onProgress && (i%64===0 || i===count-1)) onProgress(i+1,count);
  }
  return out;
}

