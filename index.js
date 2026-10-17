const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN; 

// Webhook verification endpoint (GET request from Meta)
app.get('/webhook', (req, res) => {
    let mode = req.query['hub.mode'];
    let token = req.query['hub.verify_token'];
    let challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    }
});

// Incoming message receiver (POST request from Meta)
app.post('/webhook', (req, res) => {
    console.log('Incoming webhook message received');
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Bot server listening on port ${PORT}`);
});
