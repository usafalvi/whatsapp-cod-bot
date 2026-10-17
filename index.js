const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; 

// Webhook verification endpoint (GET request from Meta)
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

// Incoming message receiver (POST request from Meta)
app.post('/webhook', (req, res) => {
    console.log('Incoming webhook message received');
    return res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Bot server listening on port ${PORT}`);
});
