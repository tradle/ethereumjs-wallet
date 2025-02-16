const Wallet = require('./index.js')
const ethUtil = require('ethereumjs-util')
const crypto = require('crypto')
const scryptsy = require('scrypt-js').syncScrypt
const utf8 = require('utf8')
const aesjs = require('aes-js')

function assert (val, msg) {
  if (!val) {
    throw new Error(msg || 'Assertion failed')
  }
}

function decipherBuffer (decipher, data) {
  return Buffer.concat([decipher.update(data), decipher.final()])
}

const Thirdparty = {}

/*
 * opts:
 * - digest - digest algorithm, defaults to md5
 * - count - hash iterations
 * - keysize - desired key size
 * - ivsize - desired IV size
 *
 * Algorithm form https://www.openssl.org/docs/manmaster/crypto/EVP_BytesToKey.html
 *
 * FIXME: not optimised at all
 */
function evp_kdf (data, salt, opts) { // eslint-disable-line camelcase
  // A single EVP iteration, returns `D_i`, where block equlas to `D_(i-1)`
  function iter (block) {
    let hash = crypto.createHash(opts.digest || 'md5')
    hash.update(block)
    hash.update(data)
    hash.update(salt)
    block = hash.digest()

    for (let i = 1; i < (opts.count || 1); i++) {
      hash = crypto.createHash(opts.digest || 'md5')
      hash.update(block)
      block = hash.digest()
    }

    return block
  }

  const keysize = opts.keysize || 16
  const ivsize = opts.ivsize || 16

  const ret = []

  let i = 0
  while (Buffer.concat(ret).length < (keysize + ivsize)) {
    ret[i] = iter((i === 0) ? Buffer.alloc(0) : ret[i - 1])
    i++
  }

  const tmp = Buffer.concat(ret)

  return {
    key: tmp.slice(0, keysize),
    iv: tmp.slice(keysize, keysize + ivsize)
  }
}

// http://stackoverflow.com/questions/25288311/cryptojs-aes-pattern-always-ends-with
function decodeCryptojsSalt (input) {
  const ciphertext = Buffer.from(input, 'base64')
  if (ciphertext.slice(0, 8).toString() === 'Salted__') {
    return {
      salt: ciphertext.slice(8, 16),
      ciphertext: ciphertext.slice(16)
    }
  } else {
    return {
      ciphertext: ciphertext
    }
  }
}

/*
 * This wallet format is created by https://github.com/SilentCicero/ethereumjs-accounts
 * and used on https://www.myetherwallet.com/
 */
Thirdparty.fromEtherWallet = function (input, password) {
  const json = (typeof input === 'object') ? input : JSON.parse(input)

  let privKey
  if (!json.locked) {
    if (json.private.length !== 64) {
      throw new Error('Invalid private key length')
    }

    privKey = Buffer.from(json.private, 'hex')
  } else {
    if (typeof password !== 'string') {
      throw new Error('Password required')
    }
    if (password.length < 7) {
      throw new Error('Password must be at least 7 characters')
    }

    // the "encrypted" version has the low 4 bytes
    // of the hash of the address appended
    let cipher = json.encrypted ? json.private.slice(0, 128) : json.private

    // decode openssl ciphertext + salt encoding
    cipher = decodeCryptojsSalt(cipher)

    if (!cipher.salt) {
      throw new Error('Unsupported EtherWallet key format')
    }

    // derive key/iv using OpenSSL EVP as implemented in CryptoJS
    const evp = evp_kdf(Buffer.from(password), cipher.salt, { keysize: 32, ivsize: 16 })

    const decipher = crypto.createDecipheriv('aes-256-cbc', evp.key, evp.iv)
    privKey = decipherBuffer(decipher, Buffer.from(cipher.ciphertext))

    // NOTE: yes, they've run it through UTF8
    privKey = Buffer.from(utf8.decode(privKey.toString()), 'hex')
  }

  const wallet = new Wallet(privKey)

  if (wallet.getAddressString() !== json.address) {
    throw new Error('Invalid private key or address')
  }

  return wallet
}

Thirdparty.fromEtherCamp = function (passphrase) {
  return new Wallet(ethUtil.keccak256(Buffer.from(passphrase)))
}

Thirdparty.fromKryptoKit = function (entropy, password) {
  function kryptoKitBrokenScryptSeed (buf) {
    // js-scrypt calls `Buffer.from(String(salt), 'utf8')` on the seed even though it is a buffer
    //
    // The `buffer`` implementation used does the below transformation (doesn't matches the current version):
    // https://github.com/feross/buffer/blob/67c61181b938b17d10dbfc0a545f713b8bd59de8/index.js

    function decodeUtf8Char (str) {
      try {
        return decodeURIComponent(str)
      } catch (err) {
        return String.fromCharCode(0xFFFD) // UTF 8 invalid char
      }
    }

    let res = ''
    let tmp = ''

    for (let i = 0; i < buf.length; i++) {
      if (buf[i] <= 0x7F) {
        res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
        tmp = ''
      } else {
        tmp += '%' + buf[i].toString(16)
      }
    }

    return Buffer.from(res + decodeUtf8Char(tmp))
  }

  if (entropy[0] === '#') {
    entropy = entropy.slice(1)
  }

  const type = entropy[0]
  entropy = entropy.slice(1)

  let privKey
  if (type === 'd') {
    privKey = ethUtil.sha256(Buffer.from(entropy))
  } else if (type === 'q') {
    if (typeof password !== 'string') {
      throw new Error('Password required')
    }

    const encryptedSeed = ethUtil.sha256(Buffer.from(entropy.slice(0, 30)))
    const checksum = entropy.slice(30, 46)

    const salt = kryptoKitBrokenScryptSeed(encryptedSeed)
    const aesKey = scryptsy(Buffer.from(password, 'utf8'), salt, 16384, 8, 1, 32)

    /* FIXME: try to use `crypto` instead of `aesjs`

    // NOTE: ECB doesn't use the IV, so it can be anything
    var decipher = crypto.createDecipheriv("aes-256-ecb", aesKey, Buffer.alloc(0))

    // FIXME: this is a clear abuse, but seems to match how ECB in aesjs works
    privKey = Buffer.concat([
      decipher.update(encryptedSeed).slice(0, 16),
      decipher.update(encryptedSeed).slice(0, 16),
    ])
    */

    /* eslint-disable new-cap */
    const decipher = new aesjs.ModeOfOperation.ecb(aesKey)
    /* eslint-enable new-cap */
    privKey = Buffer.concat([
      decipher.decrypt(encryptedSeed.slice(0, 16)),
      decipher.decrypt(encryptedSeed.slice(16, 32))
    ])

    if (checksum.length > 0) {
      if (checksum !== ethUtil.sha256(ethUtil.sha256(privKey)).slice(0, 8).toString('hex')) {
        throw new Error('Failed to decrypt input - possibly invalid passphrase')
      }
    }
  } else {
    throw new Error('Unsupported or invalid entropy type')
  }

  return new Wallet(privKey)
}

Thirdparty.fromQuorumWallet = function (passphrase, userid) {
  assert(passphrase.length >= 10)
  assert(userid.length >= 10)

  let seed = passphrase + userid
  seed = crypto.pbkdf2Sync(seed, seed, 2000, 32, 'sha256')

  return new Wallet(seed)
}

module.exports = Thirdparty
