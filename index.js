// index.js (Render / Node) - MODO TEST
// npm i express axios body-parser
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(bodyParser.json());

// ======= FLAGS / ENV =======
const TEST_MODE   = String(process.env.TEST_MODE || '0') === '1';   // <-- poné 1 en Render
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || 'TESTUSER1761969225'; // token del vendedor de PRUEBA
const PUBLIC_URL  = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || 'https://chelas.onrender.com';

// ======= CATALOGO (TEST) =======
const CATALOG = {
  bar1test: { title: 'Pinta Rubia (TEST)', price: 100 },
  // podés sumar bar2test / bar3test si querés
};

// ======= ESTADO POR DISPOSITIVO =======
const state = {};
for (const dev of Object.keys(CATALOG)) state[dev] = { link: '', pagado: false, prefId: '' };

// ======= HELPERS =======
async function crearPreferencia(dev) {
  const item = CATALOG[dev];
  if (!item) throw new Error(`Dispositivo desconocido: ${dev}`);

  const payload = {
    items: [{
      title: item.title,
      quantity: 1,
      currency_id: 'ARS',
      unit_price: item.price
    }],
    external_reference: dev,                    // vincula el pago con el dispositivo
    notification_url: `${PUBLIC_URL}/ipn`,     // webhook directo a /ipn de esta app
    // back_urls opcionales si querés
  };

  const res = await axios.post(
    'https://api.mercadopago.com/checkout/preferences',
    payload,
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );

  // En TEST usamos sandbox_init_point
  const link = TEST_MODE ? res.data.sandbox_init_point : res.data.init_point;

  state[dev].prefId = res.data.id;
  state[dev].link   = link;

  console.log(`🔄 [${dev}] Nueva preferencia: ${state[dev].prefId} | TEST_MODE=${TEST_MODE}`);
  return state[dev].link;
}

async function generarNuevoLinkSiHaceFalta(dev) {
  if (!state[dev].link || !state[dev].prefId) {
    await crearPreferencia(dev);
  }
  return state[dev].link;
}

// ======= ENDPOINTS =======
app.get('/ping', (req, res) => res.sendStatus(200));

app.get('/nuevo-link', async (req, res) => {
  try {
    const dev = String(req.query.dev || '').trim();
    if (!dev || !state[dev]) return res.status(400).json({ error: 'dev invalido' });
    if (req.query.force) await crearPreferencia(dev);
    else await generarNuevoLinkSiHaceFalta(dev);
    return res.json({ link: state[dev].link, test: TEST_MODE });
  } catch (e) {
    console.error('❌ /nuevo-link error:', e.response?.data || e.message);
    return res.status(500).json({ error: 'nuevo-link fail' });
  }
});

app.get('/estado', (req, res) => {
  const dev = String(req.query.dev || '').trim();
  if (!dev || !state[dev]) return res.status(400).json({ error: 'dev invalido' });
  const resp = { pagado: !!state[dev].pagado };
  state[dev].pagado = false; // consumir flag
  return res.json(resp);
});

app.post('/ipn', async (req, res) => {
  try {
    const id    = req.query['id']    || req.body?.data?.id;
    const topic = req.query['topic'] || req.body?.type;

    if (topic !== 'payment') return res.sendStatus(200);
    if (!id) return res.sendStatus(200);

    const info = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const pago = info.data;
    const estado = pago.status;                         // 'approved'
    const prefId = pago.preference_id;                  // debe coincidir
    const devRef = pago.external_reference || '';       // bar1test
    const email  = pago.payer?.email || 'sin email';

    console.log(`📩 IPN pago ${id}: ${estado} | pref=${prefId} | ref=${devRef} | ${email}`);

    let dev = '';
    if (devRef && state[devRef]) dev = devRef;
    else dev = Object.keys(state).find(k => state[k].prefId === prefId) || '';

    if (!dev) {
      console.log('⚠️ No se pudo mapear el pago a un dispositivo');
      return res.sendStatus(200);
    }

    if (estado === 'approved' && state[dev].prefId === prefId) {
      state[dev].pagado = true;
      console.log(`✅ [${dev}] Pago OK (TEST=${TEST_MODE}); pagado=true`);
      try {
        await crearPreferencia(dev); // preparar siguiente QR enseguida
        console.log(`🔁 [${dev}] Link renovado post-pago`);
      } catch (err) {
        console.error(`❌ [${dev}] error creando nueva preferencia:`, err.response?.data || err.message);
      }
    } else {
      console.log(`⚠️ [${dev}] Pago ignorado: estado=${estado} o pref no coincide`);
    }
    res.sendStatus(200);
  } catch (e) {
    console.error('❌ IPN error:', e.response?.data || e.message);
    res.sendStatus(200);
  }
});

// Inicializar (opcional)
(async () => {
  for (const dev of Object.keys(state)) {
    try { await crearPreferencia(dev); }
    catch (e) { console.error(`❌ init ${dev}:`, e.response?.data || e.message); }
  }
})();

app.listen(PORT, () => {
  console.log(`Servidor activo en ${PUBLIC_URL || `http://localhost:${PORT}`}`);
  console.log(`TEST_MODE=${TEST_MODE}`);
});
