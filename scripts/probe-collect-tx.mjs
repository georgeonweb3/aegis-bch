// One-off probe: is the V5 collect tx a9f1388f... confirmed? And what is the
// V5 pool's tx history (does the collect tx appear at all)?
const COLLECT_TX = 'a9f1388f850c83b6674ed2a6d3f79baf79e7fe835b42520bde480f5929290f53';
const POOL_ADDR = 'bchtest:rvpyzut9z2ckw6ryawl6q9hjpsf7jnpf9dwfhmhezwpkdse794cvsyu6rh5sv';

const ws = new WebSocket('ws://127.0.0.1:15004');
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error) p.reject(new Error(JSON.stringify(d.error)));
  else p.resolve(d.result);
};
ws.onerror = () => { console.log('WS ERR'); process.exit(1); };
ws.onopen = async () => {
  try {
    console.log('server:', JSON.stringify(await send('server.version', ['probe', '1.4'])));
    try {
      const tx = await send('blockchain.transaction.get', [COLLECT_TX, true]);
      console.log('collect tx FOUND: confirmations=', tx.confirmations, 'height=', tx.height, 'blockhash=', String(tx.blockhash || '').slice(0, 16));
      console.log('  vin:', (tx.vin || []).map((v) => `${String(v.txid).slice(0, 12)}:${v.vout}`).join(' '));
      for (const [i, o] of (tx.vout || []).entries()) console.log(`  vout ${i}: value=${o.value}`);
    } catch (e) {
      console.log('collect tx NOT FOUND on this node:', e.message);
    }
    const addr = await send('blockchain.address.get_scripthash', [POOL_ADDR]);
    const hist = await send('blockchain.scripthash.get_history', [addr]);
    console.log('pool history entries:', hist.length);
    for (const h of hist) console.log('  ', h.tx_hash, 'height=', h.height);
    process.exit(0);
  } catch (e) {
    console.log('PROBE FAIL:', e.message);
    process.exit(1);
  }
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
