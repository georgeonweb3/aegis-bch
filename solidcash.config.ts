import { defineConfig } from '@solidcash/solidhat/config';

export default defineConfig({
  paths: {
    contracts: 'contracts',
    artifacts: 'artifacts',
    tests: 'test',
  },
  compiler: { evmCompat: true },
  typegen: {
    targets: [{ target: 'ethers6', layout: 'typechain', outDir: 'typechain-types' }],
  },
  mnemonic: process.env.SOLIDCASH_MNEMONIC,
  accounts: { count: 1, satoshis: 100_000_000n },
  networks: {
    mock: { type: 'mock' },
    regtest: {
      type: 'regtest',
      rpc: {
        url: process.env.REGTEST_RPC_URL ?? 'http://127.0.0.1:18443',
        user: process.env.REGTEST_RPC_USER ?? 'user',
        password: process.env.REGTEST_RPC_PASSWORD ?? 'password',
      },
    },
    // VM workaround: direct egress to chipnet.bch.ninja:50004 never completes
    // a WebSocket handshake from this VM (TCP connects, upgrade hangs; the
    // same endpoint answers in ~1.4s via the egress proxy). With
    // SOLIDCASH_ELECTRUM_LOCAL=1, route the Electrum WS through the local
    // forwarder (scripts/ws-forward.mjs: plain ws on 127.0.0.1:15004, TLS to
    // the real server via proxy CONNECT). Unset = default direct server.
    chipnet: {
      type: 'electrum',
      network: 'chipnet',
      mnemonic: process.env.SOLIDCASH_MNEMONIC_CHIPNET,
      ...(process.env.SOLIDCASH_ELECTRUM_LOCAL === '1'
        ? { electrum: { host: '127.0.0.1', port: 15004, encrypted: false } }
        : {}),
    },
    mainnet: { type: 'electrum', network: 'mainnet', mnemonic: process.env.SOLIDCASH_MNEMONIC_MAINNET },
  },
  defaultNetwork: 'mock',
});
