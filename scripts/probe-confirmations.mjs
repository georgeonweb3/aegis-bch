// Probe 2: confirmation status of every chipnet state tx so far, + AegisBCH
// address history as a control (does the history query work at all?).
const TXS = {
  'V5 setRoot': 'abc22459f0f1bf2a110a03add0b264ca8a517209f10049e51fdb06c2ddfe241c',
  'V5 claim': '5bac2129571815f0c2cfb407131faa659c16dcb403abef4aed5a9850268a2082',
  'V5 collect': 'a9f1388f850c83b6674ed2a6d3f79baf79e7fe835b42520bde480f5929290f53',
  'Aegis create': '83429147c3d114b741805fc69f21b2c4b7aa8932f12bfbd633b8986e79e37c38',
  'Aegis deposit': 'ec2b6dfd73f3d3574922ec694f9f7f4897892adcdfd19c9a8277ef7643c0b027',
  'Aegis spend': 'c789c7af50833e67ce31f0579509a59372650c487e967e0fd9ed70e220274b9b',
  'Aegis withdraw': '8ebdba076f7e3996c4c7db4034e5a82cb2d162efc267448818fdbcd339a4727c',
  'V5 genesis': '0ce114e3dfa5bce4b72f0e6dc9f308ff06be2f4747f352fef4f1a918b23ddb4b',
  'Aegis genesis': 'fac67a5e87c4f1248682820d0d721a3570df1d39c1d34f24daf4a9c47d4e8f30',
};
const AEGIS_ADDR = 'bchtest:rw28k9m5w3wyxptrkj6tx3mw6p4474meqfx596rkaz9eg5jsj2lv5pjm6q5kq';

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
    for (const [name, txid] of Object.entries(TXS)) {
      try {
        const tx = await send('blockchain.transaction.get', [txid, true]);
        console.log(`${name}: confirmations=${tx.confirmations} height=${tx.height} size=${tx.size}`);
      } catch (e) {
        console.log(`${name}: NOT FOUND (${e.message.slice(0, 80)})`);
      }
    }
    const sh = await send('blockchain.address.get_scripthash', [AEGIS_ADDR]);
    const hist = await send('blockchain.scripthash.get_history', [sh]);
    console.log('AegisBCH history entries:', hist.length);
    for (const h of hist) console.log('  ', h.tx_hash.slice(0, 12), 'height=', h.height);
    process.exit(0);
  } catch (e) {
    console.log('PROBE FAIL:', e.message);
    process.exit(1);
  }
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 90000);
