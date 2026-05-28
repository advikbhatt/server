import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from local .env files if present
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

const app = express();
const port = 3001;

// Allow large payloads for inline images and CSS
app.use(express.json({ limit: '50mb' }));
app.use(cors());

app.post('/api/generate-pdf', async (req, res) => {
    const { html, css } = req.body;

    if (!html) {
        return res.status(400).json({ error: 'HTML content is required' });
    }

    let browser;
    try {
        console.log(`Generating PDF... Received ${Math.round(html?.length / 1024)}KB HTML and ${Math.round(css?.length / 1024)}KB CSS.`);
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        const page = await browser.newPage();

        // Inject Tailwind/Global CSS and the HTML content
        const finalHtml = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    ${css || ''}
                    
                    /* Force A4 Print Settings and Fix Puppeteer Rendering Quirks */
                    @page {
                        size: A4 portrait;
                        margin: 0;
                    }

                    body {
                        margin: 0;
                        padding: 0;
                        -webkit-print-color-adjust: exact !important;
                        print-color-adjust: exact !important;
                        width: 210mm !important;
                        height: 297mm !important;
                    }
                    
                    /* The container holding the resume */
                    .print-container {
                        width: 210mm !important;
                        min-height: 297mm !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        background-color: white !important;
                        /* Neutralize any zoom or scaling placed on parent wrappers */
                        transform: none !important;
                    }
                    
                    /* Fallback to system fonts for foolproof rendering if webfonts fail */
                    * {
                        font-family: Arial, Helvetica, sans-serif, Times !important;
                    }
                </style>
            </head>
            <body>
                ${html}
            </body>
            </html>
        `;

        // Using a simpler waitUntil 'load' to avoid strict networkidle timeouts which fail on slow image loads
        await page.setContent(finalHtml, { waitUntil: 'load', timeout: 30000 });

        // Wait a slight fraction for any custom fonts/layouts to settle if absolutely needed
        await new Promise(r => setTimeout(r, 500));

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="resume.pdf"'
        });

        res.send(Buffer.from(pdfBuffer));
        console.log('PDF generated successfully.');

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({ error: 'Failed to generate PDF' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});


// --- PayYantra Integration ---
const PAYYANTRA_BASE_URL = process.env.PAYYANTRA_BASE_URL || 'https://payin-api.payyantra.com';
const CLIENT_ID = process.env.PAYYANTRA_CLIENT_ID;
const CLIENT_SECRET = process.env.PAYYANTRA_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('WARNING: PAYYANTRA_CLIENT_ID or PAYYANTRA_CLIENT_SECRET environment variables are not set.');
}


const ORDERS_FILE = path.resolve('orders.json');

// Helper to read local orders
function readOrders() {
    try {
        if (!fs.existsSync(ORDERS_FILE)) {
            return {};
        }
        const data = fs.readFileSync(ORDERS_FILE, 'utf8');
        return JSON.parse(data || '{}');
    } catch (e) {
        console.error('Error reading orders file:', e);
        return {};
    }
}

// Helper to save local orders
function saveOrders(orders) {
    try {
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf8');
    } catch (e) {
        console.error('Error saving orders file:', e);
    }
}

// Get PayYantra Access Token
async function getPayYantraToken() {
    const response = await fetch(`${PAYYANTRA_BASE_URL}/api/auth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-client-id': CLIENT_ID,
            'x-client-secret': CLIENT_SECRET
        },
        signal: AbortSignal.timeout(5000) // Timeout after 5s
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Auth failed with status ${response.status}: ${errText.slice(0, 150)}`);
    }

    const data = await response.json();
    const token = data.token || (data.data && data.data.token);
    if (!token) {
        throw new Error('No auth token returned in PayYantra response');
    }
    return token;
}

// Endpoint to create order
app.post('/api/payyantra/create-order', async (req, res) => {
    const { amount, customerName, customerEmail, customerPhone, designCategory, planName, returnUrl } = req.body;

    if (!amount) {
        return res.status(400).json({ error: 'Amount is required' });
    }

    const referenceId = `ref_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const parsedAmount = parseFloat(amount);

    console.log(`Creating live order: Ref=${referenceId}, Amt=₹${parsedAmount}, Customer=${customerName}`);

    try {
        const token = await getPayYantraToken();
        const payload = {
            referenceId,
            amount: parsedAmount,
            currency: 'INR',
            customerName: customerName || 'Valued Customer',
            customerEmail: customerEmail || 'customer@example.com',
            customerPhone: customerPhone || '9876543210',
            notifyUrl: 'https://your-server.com/webhook',
            returnUrl: returnUrl || 'http://localhost:5173/payment-result',
            allowedPaymentMethods: ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'INTERNET_BANKING']
        };

        const response = await fetch(`${PAYYANTRA_BASE_URL}/api/v2/merchant/orders`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`PayYantra Order API returned status ${response.status}: ${errText}`);
            return res.status(response.status).json({ 
                error: `PayYantra Order creation failed: ${errText.slice(0, 200)}` 
            });
        }

        const data = await response.json();
        const checkoutUrl = data.checkoutUrl || data.paymentUrl || data.url || 
                            (data.data && (data.data.checkoutUrl || data.data.paymentUrl || data.data.url));
        
        if (!checkoutUrl) {
            console.error('Invalid PayYantra response - no checkoutUrl found:', data);
            return res.status(500).json({ error: 'Failed to retrieve checkout URL from PayYantra response' });
        }

        console.log(`PayYantra order created successfully: ${checkoutUrl}`);
        
        // Save to local database
        const orders = readOrders();
        orders[referenceId] = {
            referenceId,
            amount: parsedAmount,
            customerName,
            customerEmail,
            customerPhone,
            designCategory,
            planName,
            status: 'PENDING',
            gateway: 'PAYYANTRA',
            createdAt: new Date().toISOString()
        };
        saveOrders(orders);

        return res.json({ checkoutUrl, referenceId });
    } catch (error) {
        console.error('Order creation failed:', error.message);
        return res.status(500).json({ error: error.message || 'Internal server error during order creation' });
    }
});

// Endpoint to check order status
app.get('/api/payyantra/status/:referenceId', async (req, res) => {
    const { referenceId } = req.params;

    const orders = readOrders();
    const order = orders[referenceId];

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    try {
        const token = await getPayYantraToken();
        const response = await fetch(`${PAYYANTRA_BASE_URL}/api/pay/status/by-reference/${referenceId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            signal: AbortSignal.timeout(5000)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error(`PayYantra status API returned status ${response.status}: ${errText}`);
            return res.status(response.status).json({ error: `PayYantra status retrieval failed: ${errText.slice(0, 200)}` });
        }

        const result = await response.json();
        const payyantraStatus = result.data?.status || result.status; // e.g. SUCCESS, PENDING, FAILED
        
        // Update local order status
        order.status = payyantraStatus;
        orders[referenceId] = order;
        saveOrders(orders);

        return res.json({
            status: payyantraStatus,
            amount: order.amount,
            referenceId: order.referenceId,
            customerName: order.customerName,
            designCategory: order.designCategory,
            planName: order.planName,
            gateway: 'PAYYANTRA'
        });
    } catch (error) {
        console.error('Error fetching live order status from PayYantra:', error.message);
        return res.status(500).json({ error: error.message || 'Internal server error fetching status' });
    }
});

app.listen(port, () => {
    console.log(`PDF Generator server listening on port ${port}`);
});

