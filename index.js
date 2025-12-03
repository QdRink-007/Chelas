// index.js – Servidor QdRink multi-BAR (modo test)

const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

// ================== CONFIG ==================

const ACCESS_TOKEN =
  process.env.MP_ACCESS_TOKEN ||
  'APP_USR-7589649631038780-120213-0191c78f852bf48cc77af8fc2f1be455-2163522788';

const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000); // 5s
const WEBHOOK_URL =
  process.env.WEBHOOK_URL || 'https://chelas.onrender.com/ipn';

const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];

const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 120 }
};

// Estado por dispositivo
const stateByDev = {};
ALLOWED_DEVS.forEach(dev => {
  stateByDev[dev] = {
    pagado: false,
    ultimaPreferencia: null,
    linkActual: null,
  };
});

// Historial simple de pagos (también se loguea en archivo)
const pagos = [];

// ================== MIDDLEWARE ==================

app.use(bodyParser.json());

// ================== HELPERS MP ==================

async function generarNuevoLinkParaDev(dev) {
  const item = ITEM_BY_DEV[dev];
  if (!item) throw new Error(`Item no definido para dev=${dev}`);

  const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };

  const body = {
    items: [item],
    external_reference: dev,       // 🔐 clave para saber a qué bar pertenece
    notification_url: WEBHOOK_URL  // 🔔 a dónde MP envía la IPN
  };

  const res = await axios.post(
    'https://api.mercadopago.com/checkout/preferences',
    body,
    { headers }
  );

  const pref = res.data;
  const prefId = pref.id || pref.preference_id;

  stateByDev[dev].ultimaPreferencia = prefId;
  stateByDev[dev].linkActual = pref.init_point;

  console.log(`🔄 Nuevo link generado para ${dev}:`, {
    preference_id: prefId,
    link: pref.init_point
  });

  return {
    preference_id: prefId,
    link: pref.init_point,
  };
}

function recargarLinkConReintento(dev, intento = 1) {
  const MAX_INTENTOS = 5;
  const esperaMs = 2000 * intento;

  generarNuevoLinkParaDev(dev).catch(err => {
    console.error(`❌ Error al regenerar link para ${dev} (intento ${intento}):`,
      err.response?.data || err.message);

    if (intento < MAX_INTENTOS) {
      console.log(`⏳ Reintentando generar link para ${dev} en ${esperaMs} ms...`);
      setTimeout(() => recargarLinkConReintento(dev, intento + 1), esperaMs);
    } else {
      console.log(`⚠️ Se agotaron los reintentos para ${dev}, se mantiene el último link válido.`);
    }
  });
}

// ================== RUTAS PRINCIPALES ==================

// Ping simple
app.get('/', (req, res) => {
  res.send('Servidor QdRink Chelas OK');
});

// Nuevo link para un dev
app.get('/nuevo-link', async (req, res) => {
  try {
    const dev = (req.query.dev || '').toLowerCase();
    if (!ALLOWED_DEVS.includes(dev)) {
      return res.status(400).json({ error: 'dev invalido' });
    }

    const info = await generarNuevoLinkParaDev(dev);

    res.json({
      dev,
      link: info.link,
      title: ITEM_BY_DEV[dev].title,
      price: ITEM_BY_DEV[dev].unit_price
    });
  } catch (error) {
    console.error('❌ Error en /nuevo-link:', error.response?.data || error.message);
    res.status(500).json({ error: 'no se pudo generar link' });
  }
});

// Estado para ESP
app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();
  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev invalido' });
  }

  const st = stateByDev[dev];

  // Devolvemos y reseteamos la bandera
  const flag = st.pagado;
  if (flag) st.pagado = false;

  res.json({ dev, pagado: flag });
});

// Panel web simple
app.get('/panel', (req, res) => {
  let html = `
    <html>
    <head>
      <meta charset="utf-8" />
      <title>Panel QdRink TEST</title>
      <style>
        body { font-family: sans-serif; background:#111; color:#eee; }
        table { border-collapse: collapse; width: 100%; margin-top: 10px; }
        th, td { border: 1px solid #444; padding: 6px 8px; font-size: 13px; }
        th { background: #222; }
        tr:nth-child(even) { background:#1b1b1b; }
      </style>
    </head>
    <body>
      <h1>Panel QdRink TEST</h1>
      <table>
        <tr>
          <th>Fecha/Hora</th><th>Dev</th><th>Producto</th><th>Monto</th>
          <th>Email</th><th>Estado</th><th>Medio</th><th>payment_id</th><th>pref_id</th>
        </tr>
  `;

  pagos.slice().reverse().forEach(p => {
    html += `
      <tr>
        <td>${p.fechaHora}</td>
        <td>${p.dev}</td>
        <td>${p.title}</td>
        <td>${p.monto}</td>
        <td>${p.email}</td>
        <td>${p.estado}</td>
        <td>${p.metodo}</td>
        <td>${p.payment_id}</td>
        <td>${p.preference_id || ''}</td>
      </tr>
    `;
  });

  html += `
      </table>
    </body>
    </html>
  `;

  res.send(html);
});

// ================== IPN / WEBHOOK ==================

app.post('/ipn', async (req, res) => {
  try {
    console.log('📥 IPN recibida:', { query: req.query, body: req.body });

    // MP puede mandar el id en varios campos
    const paymentId =
      req.query['data.id'] ||
      req.body['data.id'] ||
      req.body?.data?.id ||
      req.query.id ||
      req.body.id;

    if (!paymentId) {
      console.log('⚠️ IPN sin payment_id. Nada que hacer.');
      return res.sendStatus(200);
    }

    const headers = { Authorization: `Bearer ${ACCESS_TOKEN}` };
    const url = `https://api.mercadopago.com/v1/payments/${paymentId}`;

    const mpRes = await axios.get(url, { headers });
    const data = mpRes.data;

    const estado = data.status;
    const email = data.payer?.email || 'sin email';
    const monto = data.transaction_amount;
    const metodo = data.payment_method_id;
    const descripcion = data.description;
    const externalRef = data.external_reference || null;
    const preference_id = data.preference_id || null;

    console.log('📩 Pago recibido:', {
      estado,
      email,
      monto,
      metodo,
      descripcion,
      externalRef,
    });
    console.log('🔎 preference_id del pago:', preference_id);

    // 🔐 ACÁ usamos external_reference para saber qué BAR es
    const dev = ALLOWED_DEVS.includes(externalRef) ? externalRef : null;
    console.log('🔐 dev detectado por external_reference:', dev || 'ninguno');

    if (estado === 'approved' && dev) {
      const st = stateByDev[dev];
      st.pagado = true;

      const fechaHora = new Date().toLocaleString('es-AR', {
        timeZone: 'America/Argentina/Buenos_Aires',
      });

      console.log(`✅ Pago confirmado y válido para ${dev}`);

      const registro = {
        fechaHora,
        dev,
        email,
        estado,
        monto,
        metodo,
        descripcion,
        payment_id: paymentId,
        preference_id,
        title: ITEM_BY_DEV[dev].title,
      };

      pagos.push(registro);

      const logMsg =
        `🕒 ${fechaHora} | Dev: ${dev}` +
        ` | Producto: ${ITEM_BY_DEV[dev].title}` +
        ` | Monto: ${monto}` +
        ` | Pago de: ${email}` +
        ` | Estado: ${estado}` +
        ` | externalRef: ${externalRef}` +
        ` | pref: ${preference_id}` +
        ` | id: ${paymentId}\n`;

      fs.appendFileSync('pagos.log', logMsg);

      // Programar rotación de QR para este dev
      setTimeout(() => {
        recargarLinkConReintento(dev);
      }, ROTATE_DELAY_MS);
    } else {
      console.log('⚠️ Pago aprobado pero NO corresponde a ningún dev QdRink. Ignorado.');
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error en /ipn:', error.response?.data || error.message);
    res.sendStatus(200); // para que MP no reintente infinito
  }
});

// ================== ARRANQUE ==================

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log('Generando links iniciales por cada dev...');
  ALLOWED_DEVS.forEach(dev => {
    recargarLinkConReintento(dev);
  });
});
