// 1. Import Dependencies
const express = require('express');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const axios = require('axios');
const bcrypt = require('bcrypt');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util'); // Standard Node.js utility
const https = require('https'); // For creating a secure server
const fs = require('fs'); // For reading certificate files

// This code is updated for Node.js v24+, using modern async/await patterns.

// --- SQLite Database Initialization ---
const dbPath = path.resolve(__dirname, 'courier.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Fatal Error: Could not open database', err.message);
        process.exit(1); // Exit if DB connection fails
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// --- Promisify Database Methods for Async/Await ---
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = (sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) {
                console.error('Error running SQL:', err.message);
                reject(err);
            } else {
                resolve({ lastID: this.lastID, changes: this.changes });
            }
        });
    });
};

// --- Initialize Database Schema ---
const initializeDatabase = async () => {
    try {
        console.log('Initializing database schema...');
        await dbRun('PRAGMA foreign_keys = ON;');
        await dbRun(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)`);
        
        // Removed ceNumber from chaseJobs, as it's now in a separate table
        await dbRun(`CREATE TABLE IF NOT EXISTS chaseJobs (id INTEGER PRIMARY KEY AUTOINCREMENT, jobNo TEXT, customerName TEXT, productName TEXT, accountExecutive TEXT, description TEXT, status TEXT, chaseJobId INTEGER UNIQUE, createdAt TEXT)`);
        
        // New table to handle the one-to-many relationship between jobs and CE numbers
        await dbRun(`CREATE TABLE IF NOT EXISTS job_ce_numbers (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, ce_number TEXT NOT NULL, UNIQUE(job_id, ce_number), FOREIGN KEY (job_id) REFERENCES chaseJobs (id) ON DELETE CASCADE)`);

        await dbRun(`
            CREATE TABLE IF NOT EXISTS shipments (
                id INTEGER PRIMARY KEY AUTOINCREMENT, 
                trackingNumber TEXT UNIQUE, 
                senderName TEXT, senderContact TEXT, senderAddress TEXT, 
                recipientName TEXT, recipientContact TEXT, recipientAddress TEXT, 
                associatedJobNo TEXT, ceNumber TEXT, status TEXT, createdAt TEXT,
                courier_charge REAL
            )`);
        await dbRun(`CREATE TABLE IF NOT EXISTS shipment_elements (id INTEGER PRIMARY KEY AUTOINCREMENT, shipment_id INTEGER, description TEXT, quantity TEXT, FOREIGN KEY (shipment_id) REFERENCES shipments (id) ON DELETE CASCADE)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS addresses (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, contactPerson TEXT, phone TEXT, address TEXT)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS elements (id INTEGER PRIMARY KEY AUTOINCREMENT, brand TEXT, product TEXT, color TEXT, description TEXT)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
        await dbRun(`CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, currentNumber INTEGER)`);
        await dbRun("INSERT OR IGNORE INTO counters (name, currentNumber) VALUES ('shipmentCounter', 1000)");
        
        await dbRun(`
            CREATE TABLE IF NOT EXISTS delivery_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deliveryNoteNumber TEXT UNIQUE,
                clientName TEXT,
                date TEXT,
                address TEXT,
                contactPerson TEXT,
                contactNumber TEXT,
                jobNo TEXT,
                ceNumber TEXT,
                subtotal REAL,
                vat REAL,
                total REAL,
                createdAt TEXT
            )`);
        await dbRun(`
            CREATE TABLE IF NOT EXISTS delivery_note_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                delivery_note_id INTEGER,
                quantity INTEGER,
                description TEXT,
                price REAL,
                FOREIGN KEY (delivery_note_id) REFERENCES delivery_notes(id) ON DELETE CASCADE
            )`);
        await dbRun("INSERT OR IGNORE INTO counters (name, currentNumber) VALUES ('deliveryNoteCounter', 1000)");

        console.log('Database tables are ready.');
    } catch (error) {
        console.error('Error initializing database schema:', error.message);
        throw error;
    }
};

const app = express();
const PORT = 3001;
const HOST = '0.0.0.0';

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Chase API Import ---
const importAllChaseData = async (username, password) => {
    console.log(`Starting Chase API import for user: ${username}...`);
    const JOB_API_URL = 'https://promosoft.chasesoftware.co.za/api/Job';
    const DOC_API_URL = 'https://promosoft.chasesoftware.co.za/api/Document/FormID/4';
    const axiosConfig = { auth: { username, password }, headers: { 'User-Agent': 'Mozilla/5.0' } };
    try {
        const jobResponse = await axios.get(JOB_API_URL, axiosConfig);
        const jobs = jobResponse.data;
        if (!jobs || !Array.isArray(jobs)) throw new Error("API response from /api/Job was not an array.");
        
        let newJobsCount = 0;
        await dbRun('BEGIN TRANSACTION');
        for (const job of jobs) {
             if (!job.JobID) continue;
             const existingJob = await dbGet('SELECT id FROM chaseJobs WHERE chaseJobId = ?', [job.JobID]);
             if (!existingJob) {
                 const newJobData = [job.JobNo || null, job.CustomerName || 'N/A', job.ProductName || 'N/A', job.AE || 'N/A', job.Description || 'N/A', 'Imported', job.JobID, new Date().toISOString()];
                 await dbRun(`INSERT INTO chaseJobs (jobNo, customerName, productName, accountExecutive, description, status, chaseJobId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newJobData);
                 newJobsCount++;
             }
        }
        await dbRun('COMMIT');


        const docResponse = await axios.get(DOC_API_URL, axiosConfig);
        const docs = docResponse.data;
        if (!docs || !Array.isArray(docs)) throw new Error("API response from /api/Document was not an array.");
        
        let newCeNumbersCount = 0;
        await dbRun('BEGIN TRANSACTION');
        for (const doc of docs) {
            if (doc.JobID && doc.DocNo) {
                const job = await dbGet('SELECT id FROM chaseJobs WHERE chaseJobId = ?', [doc.JobID]);
                if (job) {
                    const result = await dbRun('INSERT OR IGNORE INTO job_ce_numbers (job_id, ce_number) VALUES (?, ?)', [job.id, doc.DocNo]);
                    if (result.changes > 0) newCeNumbersCount++;
                }
            }
        }
        await dbRun('COMMIT');
        
        return { success: true, message: `Import complete. Added ${newJobsCount} new jobs and linked ${newCeNumbersCount} new CE numbers.` };
    } catch (error) {
        await dbRun('ROLLBACK');
        let errorMessage = 'An unknown error occurred during import.';
        if (axios.isAxiosError(error)) {
            errorMessage = error.response ? `Chase API error: ${error.response.status}` : (error.request ? 'No response from Chase API' : `Request setup error: ${error.message}`);
        } else errorMessage = error.message;
        console.error('Full import error:', error);
        return { success: false, message: errorMessage };
    }
};


// --- API Router ---
const apiRouter = express.Router();

// --- Auth Routes ---
apiRouter.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
    try {
        const row = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (row) return res.status(400).json({ message: 'Username already exists.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        await dbRun('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error registering user.' });
    }
});

apiRouter.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
        const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
        if (!user) return res.status(401).json({ message: 'Invalid credentials.' });
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) return res.status(401).json({ message: 'Invalid credentials.' });
        res.status(200).json({ message: 'Login successful!' });
    } catch (error) {
        console.error("Login error:", error.message);
        res.status(500).json({ message: 'Error logging in.' });
    }
});

// --- Data Fetching Route ---
apiRouter.get('/all-data', async (req, res) => {
    try {
        const shipments = await dbAll('SELECT * FROM shipments ORDER BY createdAt DESC');
        const addresses = await dbAll('SELECT * FROM addresses');
        const elements = await dbAll('SELECT * FROM elements');
        const chaseJobs = await dbAll('SELECT j.*, (SELECT GROUP_CONCAT(ce.ce_number) FROM job_ce_numbers ce WHERE ce.job_id = j.id) as ceNumbers FROM chaseJobs j ORDER BY j.createdAt DESC');
        const deliveryNotes = await dbAll('SELECT * FROM delivery_notes ORDER BY createdAt DESC');
        res.status(200).json({ shipments, addresses, elements, chaseJobs, deliveryNotes });
    } catch (error) {
        console.error("Error fetching all data:", error.message);
        res.status(500).json({ message: 'Error fetching initial data.' });
    }
});

// --- Individual GET Routes ---
apiRouter.get('/shipments', async (req, res) => {
    try {
        const shipments = await dbAll('SELECT * FROM shipments ORDER BY createdAt DESC');
        res.status(200).json(shipments);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching shipments.' });
    }
});
apiRouter.get('/addresses', async (req, res) => {
    try {
        const addresses = await dbAll('SELECT * FROM addresses');
        res.status(200).json(addresses);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching addresses.' });
    }
});
apiRouter.get('/elements', async (req, res) => {
    try {
        const elements = await dbAll('SELECT * FROM elements');
        res.status(200).json(elements);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching elements.' });
    }
});
apiRouter.get('/chase-jobs', async (req, res) => {
    try {
        const chaseJobs = await dbAll('SELECT j.*, (SELECT GROUP_CONCAT(ce.ce_number) FROM job_ce_numbers ce WHERE ce.job_id = j.id) as ceNumbers FROM chaseJobs j ORDER BY j.createdAt DESC');
        res.status(200).json(chaseJobs);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching chase jobs.' });
    }
});

// New endpoint to find a job by its CE number
apiRouter.get('/chase-jobs/by-ce/:ceNumber', async (req, res) => {
    try {
        const { ceNumber } = req.params;
        const job = await dbGet(`
            SELECT j.* FROM chaseJobs j 
            JOIN job_ce_numbers ce ON j.id = ce.job_id 
            WHERE ce.ce_number = ?`, 
            [ceNumber]
        );
        if (job) {
            res.status(200).json(job);
        } else {
            res.status(404).json({ message: 'Job not found for this CE number.' });
        }
    } catch (error) {
         res.status(500).json({ message: 'Error fetching job by CE number.' });
    }
});

apiRouter.get('/delivery-notes', async (req, res) => {
    try {
        const deliveryNotes = await dbAll('SELECT * FROM delivery_notes ORDER BY createdAt DESC');
        res.status(200).json(deliveryNotes);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching delivery notes.' });
    }
});


// --- Shipments CRUD ---
apiRouter.post('/shipments', async (req, res) => {
    const { 
        senderName, senderContact, senderAddress, 
        recipientName, recipientContact, recipientAddress, 
        associatedJobNo, ceNumber, elements,
        courier_charge 
    } = req.body;

    if (!senderName || !senderAddress || !recipientName || !recipientAddress) {
        return res.status(400).json({ message: 'Missing required sender/recipient fields.' });
    }

    try {
        await dbRun('BEGIN TRANSACTION');
        const counter = await dbGet("SELECT currentNumber FROM counters WHERE name = 'shipmentCounter'");
        const newCount = (counter ? counter.currentNumber : 1000) + 1;
        const trackingNumber = `T${newCount}`;
        
        const finalCharge = parseFloat(courier_charge) || null;

        const shipmentCols = [
            senderName, senderContact || null, senderAddress, 
            recipientName, recipientContact || null, recipientAddress, 
            associatedJobNo || null, ceNumber || null, 
            trackingNumber, new Date().toISOString(), 'Pending',
            finalCharge
        ];
        
        const shipmentResult = await dbRun(`
            INSERT INTO shipments (
                senderName, senderContact, senderAddress, 
                recipientName, recipientContact, recipientAddress, 
                associatedJobNo, ceNumber, trackingNumber, createdAt, status,
                courier_charge
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, shipmentCols);
        const shipmentId = shipmentResult.lastID;

        if (elements && Array.isArray(elements) && elements.length > 0) {
            for (const element of elements) {
                if (element.description && element.quantity) {
                    await dbRun('INSERT INTO shipment_elements (shipment_id, description, quantity) VALUES (?, ?, ?)', [shipmentId, element.description, element.quantity]);
                }
            }
        }
        
        await dbRun("UPDATE counters SET currentNumber = ? WHERE name = 'shipmentCounter'", [newCount]);
        await dbRun('COMMIT');
        res.status(201).json({ message: 'Shipment created successfully!', trackingNumber });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error("Error creating shipment:", error);
        res.status(500).json({ message: 'Error creating shipment record.', error: error.message });
    }
});

apiRouter.get('/shipments/:trackingNumber', async (req, res) => {
    const { trackingNumber } = req.params;
    try {
        const shipment = await dbGet('SELECT * FROM shipments WHERE trackingNumber = ?', [trackingNumber]);
        if (!shipment) return res.status(404).json({ message: 'Shipment not found.' });
        const elements = await dbAll('SELECT * FROM shipment_elements WHERE shipment_id = ?', [shipment.id]);
        shipment.elements = elements;
        res.status(200).json(shipment);
    } catch (error) {
        res.status(500).json({ message: 'Database error fetching shipment details.' });
    }
});

apiRouter.put('/shipments/:trackingNumber', async (req, res) => {
    const { trackingNumber } = req.params;
    const { 
        senderName, senderContact, senderAddress, 
        recipientName, recipientContact, recipientAddress, 
        associatedJobNo, ceNumber, status, elements,
        courier_charge
    } = req.body;
    try {
        await dbRun('BEGIN TRANSACTION');
        
        const shipment = await dbGet('SELECT id FROM shipments WHERE trackingNumber = ?', [trackingNumber]);
        if (!shipment) {
            await dbRun('ROLLBACK');
            return res.status(404).json({ message: 'Shipment not found.' });
        }

        const finalCharge = parseFloat(courier_charge) || null;

        const shipmentCols = [
            senderName, senderContact, senderAddress, 
            recipientName, recipientContact, recipientAddress, 
            associatedJobNo, ceNumber || '', status, 
            finalCharge,
            trackingNumber
        ];
        await dbRun(`
            UPDATE shipments SET 
            senderName = ?, senderContact = ?, senderAddress = ?, 
            recipientName = ?, recipientContact = ?, recipientAddress = ?, 
            associatedJobNo = ?, ceNumber = ?, status = ?,
            courier_charge = ?
            WHERE trackingNumber = ?`, shipmentCols);
        
        await dbRun('DELETE FROM shipment_elements WHERE shipment_id = ?', [shipment.id]);
        if (elements && elements.length > 0) {
            for (const element of elements) {
                await dbRun('INSERT INTO shipment_elements (shipment_id, description, quantity) VALUES (?, ?, ?)', [shipment.id, element.description, element.quantity]);
            }
        }
        
        await dbRun('COMMIT');
        res.status(200).json({ message: 'Shipment updated successfully!' });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error("Error updating shipment:", error.message);
        res.status(500).json({ message: 'Error updating shipment.' });
    }
});

apiRouter.delete('/shipments/:trackingNumber', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const result = await dbRun('DELETE FROM shipments WHERE trackingNumber = ?', [trackingNumber]);
        if (result.changes === 0) return res.status(404).json({ message: 'Shipment not found.' });
        res.status(200).json({ message: 'Shipment deleted successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting shipment.' });
    }
});

apiRouter.patch('/shipments/:trackingNumber/status', async (req, res) => {
    try {
        const { trackingNumber } = req.params;
        const { status } = req.body;
        if (!status) return res.status(400).json({ message: 'Status is required.' });
        const result = await dbRun('UPDATE shipments SET status = ? WHERE trackingNumber = ?', [status, trackingNumber]);
        if (result.changes === 0) return res.status(404).json({ message: 'Shipment not found.' });
        res.status(200).json({ message: 'Shipment status updated.' });
    } catch (error) {
        res.status(500).json({ message: 'Error updating shipment status.' });
    }
});


// --- Addresses, Elements, Settings, Chase Import ---
apiRouter.post('/addresses', async (req, res) => {
    try {
        const { name, contactPerson, phone, address } = req.body;
        const result = await dbRun('INSERT INTO addresses (name, contactPerson, phone, address) VALUES (?, ?, ?, ?)', [name, contactPerson, phone, address]);
        res.status(201).json({ message: 'Address added successfully!', id: result.lastID });
    } catch (error) {
        res.status(500).json({ message: 'Error creating address.' });
    }
});
apiRouter.put('/addresses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, contactPerson, phone, address } = req.body;
        const result = await dbRun(`UPDATE addresses SET name = ?, contactPerson = ?, phone = ?, address = ? WHERE id = ?`, [name, contactPerson, phone, address, id]);
        if (result.changes === 0) return res.status(404).json({ message: 'Address not found.' });
        res.status(200).json({ message: 'Address updated successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error updating address.' });
    }
});
apiRouter.delete('/addresses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await dbRun('DELETE FROM addresses WHERE id = ?', [id]);
        if (result.changes === 0) return res.status(404).json({ message: 'Address not found.' });
        res.status(200).json({ message: 'Address deleted successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting address.' });
    }
});
apiRouter.post('/elements', async (req, res) => {
    try {
        const { brand, product, color, description } = req.body;
        const result = await dbRun('INSERT INTO elements (brand, product, color, description) VALUES (?, ?, ?, ?)', [brand, product, color, description]);
        res.status(201).json({ message: 'Element added successfully!', id: result.lastID });
    } catch (error) {
        res.status(500).json({ message: 'Error creating element.' });
    }
});
apiRouter.put('/elements/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { brand, product, color, description } = req.body;
        const result = await dbRun(`UPDATE elements SET brand = ?, product = ?, color = ?, description = ? WHERE id = ?`, [brand, product, color, description, id]);
        if (result.changes === 0) return res.status(404).json({ message: 'Element not found.' });
        res.status(200).json({ message: 'Element updated successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error updating element.' });
    }
});
apiRouter.delete('/elements/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await dbRun('DELETE FROM elements WHERE id = ?', [id]);
        if (result.changes === 0) return res.status(404).json({ message: 'Element not found.' });
        res.status(200).json({ message: 'Element deleted successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting element.' });
    }
});
apiRouter.post('/settings/waybill', async (req, res) => {
    try {
        const settingsData = req.body;
        await dbRun('BEGIN TRANSACTION');
        for (const [key, value] of Object.entries(settingsData)) {
            await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
        }
        await dbRun('COMMIT');
        res.status(200).json({ message: 'Settings saved successfully!' });
    } catch (error) {
        await dbRun('ROLLBACK');
        res.status(500).json({ message: 'Error saving settings.' });
    }
});
apiRouter.post('/chase/import', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: 'Username and password are required for import.' });
    const result = await importAllChaseData(username, password);
    res.status(result.success ? 200 : 500).json({ message: result.message });
});

// --- Delivery Notes CRUD ---
apiRouter.post('/delivery-notes', async (req, res) => {
    const { clientName, date, address, contactPerson, contactNumber, jobNo, ceNumber, items } = req.body;

    if (!clientName || !date || !address || !items || !Array.isArray(items)) {
        return res.status(400).json({ message: 'Missing required fields.' });
    }

    try {
        await dbRun('BEGIN TRANSACTION');
        
        const subtotal = items.reduce((acc, item) => acc + (parseFloat(item.quantity) * parseFloat(item.price)), 0);
        const vat = subtotal * 0.15;
        const total = subtotal + vat;

        const counter = await dbGet("SELECT currentNumber FROM counters WHERE name = 'deliveryNoteCounter'");
        const newCount = (counter ? counter.currentNumber : 1000) + 1;
        const deliveryNoteNumber = `DN${newCount}`;
        
        const noteResult = await dbRun(
            `INSERT INTO delivery_notes (deliveryNoteNumber, clientName, date, address, contactPerson, contactNumber, jobNo, ceNumber, subtotal, vat, total, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [deliveryNoteNumber, clientName, date, address, contactPerson, contactNumber, jobNo, ceNumber, subtotal, vat, total, new Date().toISOString()]
        );
        const noteId = noteResult.lastID;

        for (const item of items) {
            // Allow items with a price of 0
            if (item.description && item.quantity && typeof item.price === 'number') {
                 await dbRun('INSERT INTO delivery_note_items (delivery_note_id, quantity, description, price) VALUES (?, ?, ?, ?)', [noteId, item.quantity, item.description, item.price]);
            }
        }
        
        await dbRun("UPDATE counters SET currentNumber = ? WHERE name = 'deliveryNoteCounter'", [newCount]);
        await dbRun('COMMIT');
        res.status(201).json({ message: 'Delivery Note created successfully!', id: noteId, deliveryNoteNumber });
    } catch (error) {
        await dbRun('ROLLBACK');
        console.error("Error creating delivery note:", error);
        res.status(500).json({ message: 'Error creating delivery note record.', error: error.message });
    }
});

apiRouter.delete('/delivery-notes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await dbRun('DELETE FROM delivery_notes WHERE id = ?', [id]);
        if (result.changes === 0) return res.status(404).json({ message: 'Delivery note not found.' });
        res.status(200).json({ message: 'Delivery note deleted successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting delivery note.' });
    }
});

// --- PDF Generation Routes ---
apiRouter.get('/shipments/:trackingNumber/waybill', async (req, res) => {
    const { trackingNumber } = req.params;
    try {
        const shipment = await dbGet('SELECT * FROM shipments WHERE trackingNumber = ?', [trackingNumber]);
        if (!shipment) return res.status(404).send('Shipment not found');

        const elements = await dbAll('SELECT * FROM shipment_elements WHERE shipment_id = ?', [shipment.id]);
        const settingsRows = await dbAll('SELECT key, value FROM settings');
        const settings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
        const jobDetails = shipment.associatedJobNo ? await dbGet('SELECT * FROM chaseJobs WHERE jobNo = ?', [shipment.associatedJobNo]) : null;
        
        const pdfDoc = await PDFDocument.create();
        let currentPage = pdfDoc.addPage();
        const { width, height } = currentPage.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const padding = 40;
        let y = height - padding;

        const wrapText = (text, f, fontSize, maxWidth) => {
            const words = text ? String(text).split(' ') : [];
            let lines = [];
            let currentLine = '';
            for (const word of words) {
                const testLine = currentLine + (currentLine ? ' ' : '') + word;
                const testWidth = f.widthOfTextAtSize(testLine, fontSize);
                if (testWidth > maxWidth) {
                    lines.push(currentLine);
                    currentLine = word;
                } else {
                    currentLine = testLine;
                }
            }
            lines.push(currentLine);
            return lines;
        };

        let logoBottomY = y;
        try {
            const logoPath = path.join(__dirname, 'logo', 'EB logo.jpg');
            if (fs.existsSync(logoPath)) {
                const imageBytes = fs.readFileSync(logoPath);
                const logoImage = await pdfDoc.embedJpg(imageBytes);
                const logoDims = logoImage.scale(0.25);
                currentPage.drawImage(logoImage, { x: padding, y: y - logoDims.height + 20, width: logoDims.width, height: logoDims.height });
                logoBottomY = y - logoDims.height;
            }
        } catch (e) { console.error("Could not embed logo from file:", e); }

        const addressLines = ['9 Zeiss Road, Kimbuilt Industrial Park', 'Unit C3, Honeydew', '2040'];
        let addressY = y;
        for (const line of addressLines) {
            const textWidth = font.widthOfTextAtSize(line, 10);
            currentPage.drawText(line, { x: width - padding - textWidth, y: addressY, font, size: 10, color: rgb(0.2, 0.2, 0.2) });
            addressY -= 15;
        }

        y = Math.min(logoBottomY, addressY) - 20;

        const waybillTitle = 'Courier Tracking Document';
        const waybillTitleWidth = boldFont.widthOfTextAtSize(waybillTitle, 24);
        currentPage.drawText(waybillTitle, { x: (width - waybillTitleWidth) / 2, y, font: boldFont, size: 24 });
        y -= 30;
        
        let headerBoxHeight = 70;
        if(shipment.courier_charge) headerBoxHeight += 20;

        currentPage.drawRectangle({ x: padding, y: y - headerBoxHeight, width: width - padding * 2, height: headerBoxHeight, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
        currentPage.drawText(`TRACKING #: ${shipment.trackingNumber}`, { x: padding + 10, y: y - 20, font: boldFont, size: 14, color: rgb(0.95, 0.1, 0.1) });
        if (shipment.associatedJobNo) currentPage.drawText(`JOB #: ${shipment.associatedJobNo}`, { x: padding + 10, y: y - 40, font: boldFont, size: 12 });
        if (shipment.ceNumber) currentPage.drawText(`CE #: ${shipment.ceNumber}`, { x: padding + 10, y: y - 60, font: boldFont, size: 12 });
        if (shipment.courier_charge) {
            currentPage.drawText(`Courier Charge: R ${shipment.courier_charge.toFixed(2)}`, { x: padding + 10, y: y - 80, font: boldFont, size: 10 });
        }
        y -= (headerBoxHeight + 10);

        const addressBoxHeight = 110;
        currentPage.drawRectangle({ x: padding, y: y - addressBoxHeight, width: width - padding * 2, height: addressBoxHeight, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
        currentPage.drawLine({ start: { x: width / 2, y: y }, end: { x: width / 2, y: y - addressBoxHeight }, thickness: 1.5, color: rgb(0, 0, 0) });

        let textY = y - 20;
        currentPage.drawText('SENDER (CLIENT):', { x: padding + 10, y: textY, font: boldFont, size: 12 });
        textY -= 20;
        currentPage.drawText(`Name: ${shipment.senderName || 'N/A'}`, { x: padding + 10, y: textY, font, size: 10 });
        textY -= 15;
        currentPage.drawText(`Contact: ${shipment.senderContact || ''}`, { x: padding + 10, y: textY, font, size: 10 });
        textY -= 15;
        const senderAddressLines = wrapText(shipment.senderAddress || 'N/A', font, 10, (width / 2) - padding - 20);
        senderAddressLines.forEach(line => { currentPage.drawText(line, { x: padding + 10, y: textY, font, size: 10 }); textY -= 15; });

        textY = y - 20;
        currentPage.drawText('RECIPIENT:', { x: width / 2 + 10, y: textY, font: boldFont, size: 12 });
        textY -= 20;
        currentPage.drawText(`Name: ${shipment.recipientName || 'N/A'}`, { x: width / 2 + 10, y: textY, font, size: 10 });
        textY -= 15;
        currentPage.drawText(`Contact: ${shipment.recipientContact || ''}`, { x: width / 2 + 10, y: textY, font, size: 10 });
        textY -= 15;
        const recipientAddressLines = wrapText(shipment.recipientAddress || 'N/A', font, 10, (width / 2) - padding - 20);
        recipientAddressLines.forEach(line => { currentPage.drawText(line, { x: width / 2 + 10, y: textY, font, size: 10 }); textY -= 15; });
        y -= addressBoxHeight + 10;
        
        if (jobDetails) {
            const descriptionLines = wrapText(jobDetails.description || 'N/A', font, 10, width - padding * 2 - 20);
            const projectBoxHeight = 60 + (descriptionLines.length * 15);
            currentPage.drawRectangle({ x: padding, y: y - projectBoxHeight, width: width - padding * 2, height: projectBoxHeight, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
            currentPage.drawText('PROJECT DETAILS:', { x: padding + 10, y: y - 20, font: boldFont, size: 12 });
            currentPage.drawText(`Client: ${jobDetails.customerName || 'N/A'}`, { x: padding + 10, y: y - 40, font, size: 10 });
            currentPage.drawText(`Product: ${jobDetails.productName || 'N/A'}`, { x: padding + 10, y: y - 55, font, size: 10 });
            let descY = y - 70;
            descriptionLines.forEach(line => { currentPage.drawText(line, { x: padding + 10, y: descY, font, size: 10 }); descY -= 15; });
            y -= projectBoxHeight + 10;
        }

        if (elements && elements.length > 0) {
            const bottomMargin = padding + 150;
            if (y < bottomMargin + 40) { currentPage = pdfDoc.addPage(); y = currentPage.getSize().height - padding; }
            currentPage.drawText('ELEMENTS / ITEMS:', { x: padding + 10, y: y - 20, font: boldFont, size: 12 });
            y -= 40;
            for (const item of elements) {
                const descriptionLines = wrapText(item.description || 'N/A', font, 10, width - padding * 2 - 180);
                const itemHeight = Math.max(30, (descriptionLines.length * 15) + 15);
                if (y - itemHeight < bottomMargin) { currentPage = pdfDoc.addPage(); y = currentPage.getSize().height - padding; }
                let currentItemY = y - 10;
                descriptionLines.forEach(line => { currentPage.drawText(line, { x: padding + 20, y: currentItemY, font, size: 10 }); currentItemY -= 15; });
                currentPage.drawText(`Qty: ${item.quantity || 'N/A'}`, { x: width - padding - 150, y: y - 10, font, size: 10 });
                currentPage.drawRectangle({x: width - padding - 100, y: y - 12, width: 15, height: 15, borderColor: rgb(0,0,0), borderWidth: 1});
                currentPage.drawText('Packed', { x: width - padding - 80, y: y - 10, font, size: 10 });
                y -= itemHeight;
            }
        }
        
        const pages = pdfDoc.getPages();
        const creationDate = shipment.createdAt ? new Date(shipment.createdAt).toLocaleString('en-ZA') : 'N/A';
        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            const { width: pageWidth } = page.getSize();
            if (i === pages.length - 1) {
                const signatureY = padding + 80;
                page.drawRectangle({ x: padding, y: signatureY - 60, width: pageWidth - padding * 2, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
                page.drawLine({ start: { x: padding, y: signatureY - 20 }, end: { x: pageWidth - padding, y: signatureY - 20 }, thickness: 0.5, color: rgb(0.75, 0.75, 0.75) });
                page.drawText('Sender Signature:', { x: padding + 10, y: signatureY - 15, font, size: 10 });
                page.drawText('Recipient Signature:', { x: width / 2 + 10, y: signatureY - 15, font, size: 10 });
            }
            const disclaimerY = padding;
            if (settings.disclaimer) page.drawText(settings.disclaimer, { x: padding, y: disclaimerY, font, size: 8, color: rgb(0.5, 0.5, 0.5) });
            const dateWidth = font.widthOfTextAtSize(creationDate, 10);
            page.drawText(creationDate, { x: pageWidth - padding - dateWidth, y: disclaimerY, font, size: 10, color: rgb(0.5, 0.5, 0.5) });
            const pageNumberText = `Page ${i + 1} of ${pages.length}`;
            const pageNumberWidth = font.widthOfTextAtSize(pageNumberText, 10);
            page.drawText(pageNumberText, { x: (pageWidth - pageNumberWidth) / 2, y: disclaimerY, font, size: 10, color: rgb(0.5, 0.5, 0.5) });
        }
        
        const pdfBytes = await pdfDoc.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=waybill-${trackingNumber}.pdf`);
        res.send(Buffer.from(pdfBytes));

    } catch (error) {
        console.error('Error generating waybill:', error);
        res.status(500).send('Could not generate waybill');
    }
});

apiRouter.get('/delivery-notes/:id/pdf', async (req, res) => {
    const { id } = req.params;
    try {
        const note = await dbGet('SELECT * FROM delivery_notes WHERE id = ?', [id]);
        if (!note) return res.status(404).send('Delivery note not found');

        const items = await dbAll('SELECT * FROM delivery_note_items WHERE delivery_note_id = ?', [id]);
        
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage();
        const { width, height } = page.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const padding = 50;
        let y = height - padding;

        // Logo top-left
        let logoBottomY = y;
        try {
            const logoPath = path.join(__dirname, 'logo', 'EB logo.jpg');
            if (fs.existsSync(logoPath)) {
                const imageBytes = fs.readFileSync(logoPath);
                const logoImage = await pdfDoc.embedJpg(imageBytes);
                const logoDims = logoImage.scale(0.25);
                page.drawImage(logoImage, { x: padding, y: y - logoDims.height + 20, width: logoDims.width, height: logoDims.height });
                logoBottomY = y - logoDims.height + 20;
            }
        } catch (e) { console.error("Could not embed logo from file:", e); }

        // Header top-right
        let rightSideY = y;
        const headerText = 'DELIVERY NOTE';
        const headerWidth = boldFont.widthOfTextAtSize(headerText, 20);
        page.drawText(headerText, { x: width - padding - headerWidth, y: rightSideY, font: boldFont, size: 20 });
        rightSideY -= 30;
        const dnText = `DN #: ${note.deliveryNoteNumber}`;
        const dnWidth = font.widthOfTextAtSize(dnText, 12);
        page.drawText(dnText, { x: width - padding - dnWidth, y: rightSideY, font: font, size: 12 });
        rightSideY -= 15;
        const dateText = `Date: ${new Date(note.date).toLocaleDateString('en-ZA')}`;
        const dateWidth = font.widthOfTextAtSize(dateText, 12);
        page.drawText(dateText, { x: width - padding - dateWidth, y: rightSideY, font: font, size: 12 });
        rightSideY -= 25; // More space

        const companyAddressLines = ['9 Zeiss Road, Kimbuilt Industrial Park', 'Unit C3, Honeydew', '2040'];
        for (const line of companyAddressLines) {
            const textWidth = font.widthOfTextAtSize(line, 10);
            page.drawText(line, { x: width - padding - textWidth, y: rightSideY, font: font, size: 10, color: rgb(0.2, 0.2, 0.2) });
            rightSideY -= 15;
        }

        y = Math.min(logoBottomY, rightSideY) - 20;
        
        // Client info
        page.drawText('DELIVER TO:', { x: padding, y, font: boldFont, size: 10 });
        y -= 15;
        page.drawText(note.clientName, { x: padding, y, font: font, size: 10 });
        y -= 15;
        page.drawText(note.address, { x: padding, y, font: font, size: 10 });
        y -= 15;
        if(note.contactPerson) page.drawText(`Att: ${note.contactPerson}`, { x: padding, y, font: font, size: 10 });
        
        // Job/CE info
        let jobInfoY = y + 30;
        if (note.ceNumber) {
            page.drawText(`CE #: ${note.ceNumber}`, { x: padding + 300, y: jobInfoY, font: boldFont, size: 10 });
            jobInfoY -= 15;
        }
        if (note.jobNo) {
            page.drawText(`Job #: ${note.jobNo}`, { x: padding + 300, y: jobInfoY, font: boldFont, size: 10 });
        }

        y -= 40;

        // Table Header
        page.drawLine({ start: { x: padding, y }, end: { x: width - padding, y }, thickness: 1.5 });
        y -= 15;
        page.drawText('QTY', { x: padding + 5, y, font: boldFont, size: 10 });
        page.drawText('DESCRIPTION', { x: padding + 80, y, font: boldFont, size: 10 });
        page.drawText('UNIT PRICE', { x: width - padding - 150, y, font: boldFont, size: 10 });
        page.drawText('TOTAL', { x: width - padding - 60, y, font: boldFont, size: 10 });
        y -= 5;
        page.drawLine({ start: { x: padding, y }, end: { x: width - padding, y }, thickness: 1.5 });
        y -= 20;

        // Table Items
        items.forEach(item => {
            const itemTotal = (parseFloat(item.quantity) || 0) * (parseFloat(item.price) || 0);
            page.drawText(String(item.quantity), { x: padding + 5, y, font, size: 10 });
            page.drawText(item.description, { x: padding + 80, y, font, size: 10 });
            page.drawText(`R ${parseFloat(item.price).toFixed(2)}`, { x: width - padding - 150, y, font, size: 10 });
            page.drawText(`R ${itemTotal.toFixed(2)}`, { x: width - padding - 60, y, font, size: 10 });
            y -= 20;
        });

        // Totals
        const totals_x = width - padding - 150;
        y -= 20;
        page.drawLine({ start: { x: totals_x - 20, y }, end: { x: width - padding, y }, thickness: 0.5 });
        y -= 20;
        page.drawText('Subtotal:', { x: totals_x, y, font: boldFont, size: 10 });
        page.drawText(`R ${note.subtotal.toFixed(2)}`, { x: width - padding - 60, y, font, size: 10 });
        y -= 20;
        page.drawText('VAT (15%):', { x: totals_x, y, font: boldFont, size: 10 });
        page.drawText(`R ${note.vat.toFixed(2)}`, { x: width - padding - 60, y, font, size: 10 });
        y -= 5;
        page.drawLine({ start: { x: totals_x - 20, y }, end: { x: width - padding, y }, thickness: 1.5 });
        y -= 15;
        page.drawText('TOTAL:', { x: totals_x, y, font: boldFont, size: 12 });
        page.drawText(`R ${note.total.toFixed(2)}`, { x: width - padding - 60, y, font: boldFont, size: 12 });


        // Footer/Signature
        y = padding + 80;
        page.drawRectangle({ x: padding, y: y - 60, width: width - padding * 2, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1.5 });
        page.drawText('Received in good order by:', { x: padding + 10, y: y - 15, font, size: 10 });
        page.drawText('Date:', { x: padding + 10, y: y - 50, font, size: 10 });

        const pdfBytes = await pdfDoc.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename=DN-${note.deliveryNoteNumber}.pdf`);
        res.send(Buffer.from(pdfBytes));

    } catch (error) {
        console.error('Error generating delivery note PDF:', error);
        res.status(500).send('Could not generate PDF');
    }
});

app.use('/api', apiRouter);

// --- Server Start ---
const startServer = async () => {
    try {
        await initializeDatabase();

        app.use(express.static(path.join(__dirname)));

        app.get(/^(?!\/api).*/, (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });

        // Use HTTPS if certificates are available, otherwise fall back to HTTP
        try {
            console.log('Attempting to load SSL certificates...');
            const privateKey = fs.readFileSync('key.pem', 'utf8');
            const certificate = fs.readFileSync('cert.pem', 'utf8');
            const credentials = { key: privateKey, cert: certificate };
            console.log('SSL certificates loaded successfully.');
            
            const httpsServer = https.createServer(credentials, app);
            httpsServer.listen(PORT, HOST, async () => {
                console.log(`✅ Secure Server is running. Listening on all interfaces.`);
                console.log(`   Access it locally at https://localhost:${PORT}`);
            });
        } catch (e) {
            console.warn('⚠️ SSL certificates not found. Starting HTTP server instead.');
            app.listen(PORT, HOST, () => {
                console.log(`✅ HTTP Server is running on http://localhost:${PORT}`);
            });
        }

        const adminUser = await dbGet('SELECT * FROM users WHERE username = ?', ['Admin']);
        if (!adminUser) {
            const hashedPassword = await bcrypt.hash('Admin', 10);
            await dbRun('INSERT INTO users (username, password) VALUES (?, ?)', ['Admin', hashedPassword]);
            console.log('Default user "Admin" created with password "Admin".');
        }

    } catch (error) {
        console.error('❌ Fatal error during server startup:');
        console.error(error);
        process.exit(1);
    }
};

startServer();

