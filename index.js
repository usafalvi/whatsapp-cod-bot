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

// PostgreSQL connection pool (ssl: false for internal Docker network)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false
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

// 1. Webhook Verification Endpoint (GET request from Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log('GET /webhook ping received');
  console.log(`Received Token: "${token}" | Expected Token: "${VERIFY_TOKEN}"`);

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED_SUCCESSFULLY');
      return res.status(200).send(challenge);
    } else {
      console.log('TOKEN_MISMATCH_OR_INVALID_MODE');
      return res.sendStatus(403);
    }
  }
  return res.status(400).send('Missing hub parameters');
});

// 2. Incoming WhatsApp Message Handler (POST request from Meta)
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
            await sendWhatsAppText(
              from, 
              `✅ Thank you! Your Order #${orderId} has been CONFIRMED. We are preparing it for shipment.`
            );
          } else if (buttonId.startsWith('CANCEL_')) {
            const orderId = buttonId.replace('CANCEL_', '');
            await pool.query(
              "UPDATE cod_orders SET status = 'CANCELLED' WHERE order_id = $1",
              [orderId]
            );
            await sendWhatsAppText(
              from, 
              `❌ Order #${orderId} has been CANCELLED. Thank you for letting us know.`
            );
          }
        } 
        // Handle Plain Text Responses
        else if (message.type === 'text') {
          const text = message.text.body;
          console.log(`User text: ${text}`);
          await sendWhatsAppText(
            from, 
            `Hi! To manage your order, please click the button on your confirmation message or reply with your Order ID.`
          );
        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error('Error handling WhatsApp webhook:', error.message);
    return res.sendStatus(200);
  }
});

// 3. Shopify / WooCommerce Order Trigger Endpoint (POST)
app.post('/api/shopify-order', async (req, res) => {
  try {
    const { order_id, customer_name, phone_number, total_amount } = req.body;

    if (!order_id || !phone_number) {
      return res.status(400).json({ error: 'Missing order_id or phone_number' });
    }

    // Format phone number to international E.164 format (e.g., 03351234567 -> 923351234567)
    let cleanPhone = phone_number.replace(/[^0-9]/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '92' + cleanPhone.substring(1);
    }

    // Save order in PostgreSQL database
    await pool.query(
      `INSERT INTO cod_orders (order_id, customer_name, phone_number, total_amount,
