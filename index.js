const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const DATABASE_URL = process.env.DATABASE_URL;

// PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

// Initialize database table on startup
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cod_orders (
        id SERIAL PRIMARY KEY,
        order_id VARCHAR(100) UNIQUE NOT NULL,
        customer_name VARCHAR(255),
        phone_number VARCHAR(50) NOT NULL,
        total_amount VARCHAR(50),
        status VARCHAR(50) DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('PostgreSQL Table cod_orders initialized successfully.');
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}
initDb();

// 1. Webhook Verification Endpoint (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED_SUCCESSFULLY');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.status(400).send('Missing hub parameters');
});

// 2. Incoming WhatsApp Message Handler (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.object === 'whatsapp_business_account') {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (message) {
        const from = message.from; // Customer's phone number
        console.log(`Incoming message from ${from}`);

        // Handle Interactive Button Responses
        if (message.type === 'interactive') {
          const buttonId = message.interactive.button_reply.id;
          console.log(`User clicked button: ${buttonId}`);

          if (buttonId.startsWith('CONFIRM_')) {
            const orderId = buttonId.replace('CONFIRM_', '');
            await pool.query(
              "UPDATE cod_orders SET status = 'CONFIRMED' WHERE order_id = $1",
              [orderId]
            );
            await sendWhatsAppText(from, `✅ Thank you! Your Order #${orderId} has been CONFIRMED. We are preparing it for shipment.`);
          } else if (buttonId.startsWith('CANCEL_')) {
            const orderId = buttonId.replace('CANCEL_', '');
            await pool.query(
              "UPDATE cod_orders SET status = 'CANCELLED' WHERE order_id = $1",
              [orderId]
            );
            await sendWhatsAppText(from, `❌ Order #${orderId} has been CANCELLED. Thank you for letting us know.`);
          }
        } 
        // Handle Plain Text Responses
        else if (message.type === 'text') {
          const text = message.text.body;
          console.log(`User text: ${text}`);
          await sendWhatsAppText(from, `Hi! To manage your order, please click the button on your confirmation message or reply with your Order ID.`);
        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Error handling WhatsApp webhook:', error.message);
    return res.sendStatus(200);
  }
});

// 3. Shopify Order Trigger Endpoint (POST)
// Called when a new COD order is created in Shopify or WooCommerce
app.post('/api/shopify-order', async (req, res) => {
  try {
    const { order_id, customer_name, phone_number, total_amount } = req.body;

    if (!order_id || !phone_number) {
      return res.status(400).json({ error: 'Missing order_id or phone_number' });
    }

    // Format phone number to international E.164 (e.g. 03351234567 -> 923351234567)
    let cleanPhone = phone_number.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '92' + cleanPhone.substring(1);
    }

    // Save order in PostgreSQL database
    await pool.query(
      `INSERT INTO cod_orders (order_id, customer_name, phone_number, total_amount, status)
       VALUES ($1, $2, $3, $4, 'PENDING')
       ON CONFLICT (order_id) DO NOTHING;`,
      [order_id, customer_name || 'Customer', cleanPhone, total_amount || '0']
    );

    // Send Interactive Confirmation Message via WhatsApp
    await sendInteractiveCODMessage(cleanPhone, customer_name, order_id, total_amount);

    return res.status(200).json({ success: true, message: 'COD confirmation sent.' });
  } catch (error) {
    console.error('Error processing order:', error.message);
    return res.status(500).json({ error: error.message });
  }
});

// Helper: Send Interactive WhatsApp Message with Confirm/Cancel Buttons
async function sendInteractiveCODMessage(toPhone, customerName, orderId, totalAmount) {
  const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;
  
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: '🛍️ Order Confirmation'
      },
      body: {
        text: `Hi ${customerName || 'there'}! 👋\n\nThank you for shopping with us! We received your Cash on Delivery order:\n\n📦 Order ID: #${orderId}\n💰 Amount: Rs. ${totalAmount}\n\nPlease click below to confirm your delivery:`
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `CONFIRM_${orderId}`,
              title: '✅ Confirm Order'
            }
          },
          {
            type: 'reply',
            reply: {
              id: `CANCEL_${orderId}`,
              title: '❌ Cancel Order'
            }
          }
        ]
      }
    }
  };

  await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

// Helper: Send Simple Text Message
async function sendWhatsAppText(toPhone, text) {
  const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;
  
  await axios.post(url, {
    messaging_product: 'whatsapp',
    to: toPhone,
    type: 'text',
    text: { body: text }
  }, {
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    }
  });
}

app.listen(PORT, () => {
  console.log(`WhatsApp COD Bot Engine listening on port ${PORT}`);
});
