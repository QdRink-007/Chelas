const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(bodyParser.json());

// ⏱️ Delay para rotar QR luego de aprobar pago (ms)
const ROTATE_DELAY_MS = Number(process.env.ROTATE_DELAY_MS || 5000); // 5 s por defecto

// Dispositivos permitidos
const ALLOWED_DEVS = ['bar1', 'bar2', 'bar3'];

// Item por dispositivo (tu catálogo)
const ITEM_BY_DEV = {
  bar1: { title: 'Pinta Rubia', quantity: 1, currency_id: 'ARS', unit_price: 100 },
  bar2: { title: 'Pinta Negra', quantity: 1, currency_id: 'ARS', unit_price: 110 },
  bar3: { title: 'Pinta Roja',  quantity: 1, currency_id: 'ARS', unit_price: 120 }
};

// Estado por dispositivo
const stateByDev = {};
ALLOWED_DEVS.forEach(dev => {
  stateByDev[dev] = {
    linkPago: '',
    pagado: false,
    ultimaPreferencia: '',
  };
});

let ultimoPaymentId = ''; // Para evitar duplicar procesamiento en IPN

// 🔐 Token de producción MP
const ACCESS_TOKEN = 'APP_USR-7589649631038780-120213-0191c78f852bf48cc77af8fc2f1be455-2163522788';

// Historial de pagos para el panel
let pagos = [];

// 🛠 Helper: esperar
function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 🔁 Generar nuevo link para un dev específico
async function generarNuevoLinkParaDev(dev) {
  const item = ITEM_BY_DEV[dev];
  if (!item) {
    console.error('❌ Intento de generar link para dev desconocido:', dev);
    return '';
  }

  try {
    const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://chelas.onrender.com/ipn';

// ...

const res = await axios.post(
  'https://api.mercadopago.com/checkout/preferences',
  {
    items: [item],
    notification_url: WEBHOOK_URL,   // 👈 agregado importante
  },
  { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
);

    const nuevoLink = res.data.init_point;
    const preferenceId = res.data.id;

    stateByDev[dev].linkPago = nuevoLink;
    stateByDev[dev].ultimaPreferencia = preferenceId;

    console.log(`🔄 Nuevo link generado para ${dev}:`, {
      preference_id: preferenceId,
      link: nuevoLink
    });

    return nuevoLink;
  } catch (error) {
    console.error(
      `❌ Error al generar nuevo link para ${dev}:`,
      error.response?.data || error.message
    );
    return '';
  }
}

// 🔁 Recarga automática con reintentos
async function recargarLinkConReintento(dev, reintentos = 3) {
  for (let intento = 1; intento <= reintentos; intento++) {
    console.log(`⏳ [${dev}] Intento ${intento} para generar link`);
    const nuevo = await generarNuevoLinkParaDev(dev);

    if (nuevo) {
      console.log(`✅ [${dev}] Link actualizado en intento ${intento}`);
      return;
    }

    await esperar(5000); // espera 5 s entre intentos
  }

  console.error(`❌ [${dev}] No se pudo regenerar el link después de varios intentos`);
}

// 🧠 ESP pide link actual: /nuevo-link?dev=bar1
app.get('/nuevo-link', async (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();

  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev inválido. Usar ?dev=bar1|bar2|bar3' });
  }

  const state = stateByDev[dev];

  // Si no hay link, intentamos generarlo (ej: primer uso, o fallo previo)
  if (!state.linkPago) {
    const nuevo = await generarNuevoLinkParaDev(dev);
    if (!nuevo) {
      return res.status(500).json({ error: 'No se pudo generar link de pago' });
    }
  }

  const item = ITEM_BY_DEV[dev];
  res.json({
    dev,
    link: state.linkPago,
    title: item.title,
    price: item.unit_price
  });
});

// ESP verifica si hubo pago: /estado?dev=bar1
app.get('/estado', (req, res) => {
  const dev = (req.query.dev || '').toLowerCase();

  if (!ALLOWED_DEVS.includes(dev)) {
    return res.status(400).json({ error: 'dev inválido. Usar ?dev=bar1|bar2|bar3' });
  }

  const state = stateByDev[dev];
  res.json({ pagado: state.pagado });

  // Reset para ese dispositivo solamente
  if (state.pagado) {
    state.pagado = false;
  }
});

// 📨 Mercado Pago notifica: /ipn
app.post('/ipn', async (req, res) => {
  const id = req.query['id'] || req.body?.data?.id;
  const topic = req.query['topic'] || req.body?.type;

  // Solo nos interesan notificaciones de pagos
  if (topic !== 'payment') return res.sendStatus(200);
  if (!id || id === ultimoPaymentId) return res.sendStatus(200);
  ultimoPaymentId = id;

  try {
    const response = await axios.get(
      `https://api.mercadopago.com/v1/payments/${id}`,
      { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
    );

    const estado = response.data.status;
    const preference_id = response.data.preference_id;
    const email = response.data.payer?.email || 'sin email';
    const monto = response.data.transaction_amount;
    const metodo = response.data.payment_method_id;
    const descripcion = response.data.description;

    console.log('📩 Pago recibido:', { estado, email, monto, metodo, descripcion });
    console.log('🔎 preference_id del pago:', preference_id);

    // Buscar a qué dev corresponde esta preference_id
    const dev = ALLOWED_DEVS.find(d => stateByDev[d].ultimaPreferencia === preference_id);

    console.log('🔐 preference_id esperado por dev:', dev || 'ninguno');

    // FILTRO CRÍTICO:
    // Solo consideramos pago válido si:
    // - está aprobado
    // - corresponde a una preference_id actual de alguno de los dev
    if (estado === 'approved' && dev) {
      const state = stateByDev[dev];
      state.pagado = true;

      const fechaHora = new Date().toLocaleString();

      console.log(`✅ Pago confirmado y válido para ${dev}`);

      const registro = {
        fechaHora,
        dev,
        email,
        estado,
        monto,
        preference_id,
        payment_id: id,
        metodo,
        descripcion,
        title: ITEM_BY_DEV[dev].title
      };

      pagos.push(registro);

      const logMsg =
        `🕒 ${fechaHora} | Dev: ${dev}` +
        ` | Producto: ${ITEM_BY_DEV[dev].title}` +
        ` | Monto: ${monto}` +
        ` | Pago de: ${email}` +
        ` | Estado: ${estado}` +
        ` | pref: ${preference_id}` +
        ` | id: ${id}\n`;

      console.log(logMsg);
      fs.appendFileSync('pagos.log', logMsg);

      // Luego de un delay, generamos nuevo link SOLO para ese dev
      setTimeout(() => {
        recargarLinkConReintento(dev);
      }, ROTATE_DELAY_MS);
    } else {
      console.log('⚠️ Pago aprobado pero NO corresponde a ninguna preference_id activa. Ignorado.');
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error al consultar pago:', error.response?.data || error.message);
    res.sendStatus(500);
  }
});

// 📊 Panel web para ver pagos
app.get('/panel', (req, res) => {
  const filas = pagos
    .map(p => {
      return `
        <tr>
          <td>${p.fechaHora}</td>
          <td>${p.dev}</td>
          <td>${p.title}</td>
          <td>${p.monto}</td>
          <td>${p.email}</td>
          <td>${p.estado}</td>
          <td>${p.payment_id}</td>
        </tr>
      `;
    })
    .join('');

  const html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8" />
    <title>QdRink - Panel de Pagos</title>
    <style>
      body { font-family: sans-serif; background: #111; color: #eee; padding: 20px; }
      h1 { color: #0f0; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { border: 1px solid #444; padding: 8px; text-align: left; font-size: 14px; }
      th { background: #222; }
      tr:nth-child(even) { background: #1a1a1a; }
      .chip { display: inline-block; padding: 4px 8px; border-radius: 4px; background: #222; margin-right: 8px; }
    </style>
  </head>
  <body>
    <h1>🧃 QdRink - Pagos Recibidos</h1>

    <div class="chip">Dispositivos: ${ALLOWED_DEVS.join(', ')}</div>
    <div class="chip">Pagos registrados: <b>${pagos.length}</b></div>

    <table>
      <thead>
        <tr>
          <th>Fecha / Hora</th>
          <th>Dev</th>
          <th>Producto</th>
          <th>Monto</th>
          <th>Email</th>
          <th>Estado</th>
          <th>Payment ID</th>
        </tr>
      </thead>
      <tbody>
        ${filas || '<tr><td colspan="7">Sin pagos aún.</td></tr>'}
      </tbody>
    </table>
  </body>
  </html>
  `;

  res.send(html);
});

// Redirigir raíz al panel
app.get('/', (req, res) => {
  res.redirect('/panel');
});

// Inicial: podés pre-generar QRs o dejar que se generen on-demand
(async () => {
  console.log('🚀 Servidor iniciando...');
  // Si querés precalentar, descomentá:
  // for (const dev of ALLOWED_DEVS) {
  //   await recargarLinkConReintento(dev);
  // }
})();

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
});  
