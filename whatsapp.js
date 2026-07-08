const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenAI } = require('@google/genai');

// Initialize our service integrations
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. WHATSAPP WEBHOOK VERIFICATION (Meta security handshake requirement)
router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === process.env.WHATSAPP_VERIFY_TOKEN) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// 2. CORE WEBHOOK EVENT RECEIVER: Processes incoming agent texts/voice messages
router.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        if (!body.entry || !body.entry[0].changes || !body.entry[0].changes[0].value.messages) {
            return res.sendStatus(200); // Ignore non-message notifications
        }

        const messageData = body.entry[0].changes[0].value.messages[0];
        const agentPhone = messageData.from; // Sender's phone layout (e.g., "2348031112222")
        let rawMessageText = "";

        // AUTHENTICATION: Identify who is texting and what company (tenant) they belong to
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('id, tenant_id, role, full_name')
            .eq('phone_number', agentPhone)
            .single();

        if (userError || !user) {
            console.log(`Unauthorized message attempt from phone: ${agentPhone}`);
            return res.sendStatus(200); // Stop silently to prevent network spam
        }

        // CAPTURE CONTENT: Handle native text messaging
        if (messageData.type === 'text') {
            rawMessageText = messageData.text.body;
        } else {
            // Future processing block for WhatsApp audio URL download/transcription strings
            return res.sendStatus(200);
        }

        // INTELLIGENT PARSING: Call Gemini 2.5 Flash to translate Nigerian real estate speech to JSON logs
        const aiResponse = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: rawMessageText,
            config: {
                systemInstruction: `You are the AI data pipeline layer for a multitenant Nigerian Real Estate SaaS.
                Analyze the agent message and extract structural updates for our Supabase database.
                User Context: Name: ${user.full_name}, Role: ${user.role}, Tenant ID: ${user.tenant_id}.
                
                Identify one of these target_tables: 'properties', 'customers', or 'transactions'.
                Normalize Nigerian names, currency parameters (e.g., "5m" to 5000000), and actions ('INSERT', 'UPDATE').
                Return absolute RAW JSON matching this schema structure, do not wrap in markdown or conversational notes:
                {
                  "target_table": "properties",
                  "action": "UPDATE",
                  "search_filters": { "plot_number": "12", "property_name": "Max Heights" },
                  "payload": { "status": "SOLD" },
                  "confirmation_summary": "Marked Max Heights Plot 12 as SOLD."
                }`,
                responseMimeType: 'application/json'
            }
        });

        const actionObject = JSON.parse(aiResponse.text);

        // DATABASE EXECUTION: Run the dynamic query extracted by Gemini
        if (actionObject.action === 'UPDATE') {
            await supabase
                .from(actionObject.target_table)
                .update(actionObject.payload)
                .match({ tenant_id: user.tenant_id, ...actionObject.search_filters });
        } else if (actionObject.action === 'INSERT') {
            await supabase
                .from(actionObject.target_table)
                .insert([{ tenant_id: user.tenant_id, ...actionObject.payload }]);
        }

        console.log(`Success execution for ${user.full_name}: ${actionObject.confirmation_summary}`);
        res.sendStatus(200);

    } catch (globalError) {
        console.error("Critical webhook processing error:", globalError.message);
        res.sendStatus(200); // Always respond 200 to Meta servers to avoid loop bans
    }
});

module.exports = router;
