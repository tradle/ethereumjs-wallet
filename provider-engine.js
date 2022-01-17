'use strict'

const inherits = require('util').inherits
const HookedWalletEthTxSubprovider = require('@tradle/web3-provider-engine/subproviders/hooked-wallet-ethtx')

module.exports = WalletSubprovider

inherits(WalletSubprovider, HookedWalletEthTxSubprovider)

function WalletSubprovider (wallet, opts) {
  opts.getAccounts = function (cb) {
    cb(null, [wallet.getAddressString()])
  }

  opts.getPrivateKey = function (address, cb) {
    if (address !== wallet.getAddressString()) {
      return cb(new Error('Account not found'))
    }

    cb(null, wallet.getPrivateKey())
  }

  WalletSubprovider.super_.call(this, opts)
}
