// 1. Import Dependencies
const express = require('express');
const cors = require('cors');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const axios = require('axios');
const bcrypt = require('bcrypt');
const path = require('path');
const mysql = require('mysql2/promise'); // <-- Use MySQL2
const https = require('https');
const fs = require('fs');

// --- MySQL Database Initialization ---
let pool;

const initializeDatabase = async () => {
    try {
        console.log('Connecting to MySQL database...');
        pool = mysql.createPool({
            uri: process.env.DATABASE_URL, // Railway provides this automatically
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // Test the connection
        const connection = await pool.getConnection();
        console.log('Connected to the MySQL database.');
        connection.release();

        console.log('Initializing database schema...');
        
        // --- Updated Schema for MySQL ---
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(255) UNIQUE,
                password VARCHAR(255)
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS chaseJobs (
                id INT PRIMARY KEY AUTO_INCREMENT,
                jobNo VARCHAR(255),
                customerName VARCHAR(255),
                productName VARCHAR(255),
                accountExecutive VARCHAR(255),
                description TEXT,
                status VARCHAR(255),
                chaseJobId INT UNIQUE,
                createdAt VARCHAR(255)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS job_ce_numbers (
                id INT PRIMARY KEY AUTO_INCREMENT,
                job_id INT NOT NULL,
                ce_number VARCHAR(255) NOT NULL,
                UNIQUE(job_id, ce_number),
                FOREIGN KEY (job_id) REFERENCES chaseJobs(id) ON DELETE CASCADE
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS shipments (
                id INT PRIMARY KEY AUTO_INCREMENT, 
                trackingNumber VARCHAR(255) UNIQUE, 
                senderName TEXT, 
                senderContact TEXT, 
                senderAddress TEXT, 
                recipientName TEXT, 
                recipientContact TEXT, 
                recipientAddress TEXT, 
                associatedJobNo TEXT, 
                ceNumber TEXT, 
                status TEXT, 
                createdAt TEXT,
                courier_charge DECIMAL(10, 2)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS shipment_elements (
                id INT PRIMARY KEY AUTO_INCREMENT,
                shipment_id INT,
                description TEXT,
                quantity VARCHAR(255),
                FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS addresses (
                id INT PRIMARY KEY AUTO_INCREMENT,
                name TEXT,
                contactPerson TEXT,
                phone TEXT,
                address TEXT
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS elements (
                id INT PRIMARY KEY AUTO_INCREMENT,
                brand TEXT,
                product TEXT,
                color TEXT,
                description TEXT
            )
        `);

        await pool.query(`CREATE TABLE IF NOT EXISTS settings (\`key\` VARCHAR(255) PRIMARY KEY, \`value\` TEXT)`);

        await pool.query(`CREATE TABLE IF NOT EXISTS counters (name VARCHAR(255) PRIMARY KEY, currentNumber INT)`);
        
        await pool.query("INSERT IGNORE INTO counters (name, currentNumber) VALUES ('shipmentCounter', 1000)");
        await pool.query("INSERT IGNORE INTO counters (name, currentNumber) VALUES ('deliveryNoteCounter', 1000)");

        console.log('Database tables are ready.');
    } catch (error) {
        console.error('Error initializing database schema:', error.message);
        throw error;
    }
};


// --- Helper functions to replace dbRun, dbGet, dbAll ---
const dbQuery = async (sql, params = []) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};

const dbExecute = async (sql, params = []) => {
    const [result] = await pool.query(sql, params);
    return { lastID: result.insertId, changes: result.affectedRows };
};


const app = express();
const PORT = process.env.PORT || 3001; // Railway provides the PORT
const HOST = '0.0.0.0';

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// --- Chase API Import (No changes needed here) ---
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
        for (const job of jobs) {
             if (!job.JobID) continue;
             const existingJob = await dbQuery('SELECT id FROM chaseJobs WHERE chaseJobId = ?', [job.JobID]);
             if (existingJob.length === 0) {
                 const newJobData = [job.JobNo || null, job.CustomerName || 'N/A', job.ProductName || 'N/A', job.AE || 'N/A', job.Description || 'N/A', 'Imported', job.JobID, new Date().toISOString()];
                 await dbExecute(`INSERT INTO chaseJobs (jobNo, customerName, productName, accountExecutive, description, status, chaseJobId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, newJobData);
                 newJobsCount++;
             }
        }

        const docResponse = await axios.get(DOC_API_URL, axiosConfig);
        const docs = docResponse.data;
        if (!docs || !Array.isArray(docs)) throw new Error("API response from /api/Document was not an array.");
        
        let newCeNumbersCount = 0;
        for (const doc of docs) {
            if (doc.JobID && doc.DocNo) {
                const job = await dbQuery('SELECT id FROM chaseJobs WHERE chaseJobId = ?', [doc.JobID]);
                if (job.length > 0) {
                    const result = await dbExecute('INSERT IGNORE INTO job_ce_numbers (job_id, ce_number) VALUES (?, ?)', [job[0].id, doc.DocNo]);
                    if (result.changes > 0) newCeNumbersCount++;
                }
            }
        }
        
        return { success: true, message: `Import complete. Added ${newJobsCount} new jobs and linked ${newCeNumbersCount} new CE numbers.` };
    } catch (error) {
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
        const rows = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
        if (rows.length > 0) return res.status(400).json({ message: 'Username already exists.' });
        const hashedPassword = await bcrypt.hash(password, 10);
        await dbExecute('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Error registering user.' });
    }
});

apiRouter.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });
        const users = await dbQuery('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(401).json({ message: 'Invalid credentials.' });
        const user = users[0];
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
        const shipments = await dbQuery('SELECT * FROM shipments ORDER BY createdAt DESC');
        const addresses = await dbQuery('SELECT * FROM addresses');
        const elements = await dbQuery('SELECT * FROM elements');
        const chaseJobs = await dbQuery('SELECT j.*, (SELECT GROUP_CONCAT(ce.ce_number) FROM job_ce_numbers ce WHERE ce.job_id = j.id) as ceNumbers FROM chaseJobs j ORDER BY j.createdAt DESC');
        const deliveryNotes = await dbQuery('SELECT * FROM delivery_notes ORDER BY createdAt DESC');
        res.status(200).json({ shipments, addresses, elements, chaseJobs, deliveryNotes });
    } catch (error) {
        console.error("Error fetching all data:", error.message);
        res.status(500).json({ message: 'Error fetching initial data.' });
    }
});

// New endpoint to find a job by its CE number
apiRouter.get('/chase-jobs/by-ce/:ceNumber', async (req, res) => {
    try {
        const { ceNumber } = req.params;
        const rows = await dbQuery(`
            SELECT j.* FROM chaseJobs j 
            JOIN job_ce_numbers ce ON j.id = ce.job_id 
            WHERE ce.ce_number = ?`, 
            [ceNumber]
        );
        if (rows.length > 0) {
            res.status(200).json(rows[0]);
        } else {
            res.status(404).json({ message: 'Job not found for this CE number.' });
        }
    } catch (error) {
         res.status(500).json({ message: 'Error fetching job by CE number.' });
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
    
    const connection = await pool.getConnection(); // Get connection for transaction
    try {
        await connection.beginTransaction();
        const [counterRows] = await connection.query("SELECT currentNumber FROM counters WHERE name = 'shipmentCounter' FOR UPDATE");
        const counter = counterRows[0];
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
        
        const [shipmentResult] = await connection.query(`
            INSERT INTO shipments (
                senderName, senderContact, senderAddress, 
                recipientName, recipientContact, recipientAddress, 
                associatedJobNo, ceNumber, trackingNumber, createdAt, status,
                courier_charge
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, shipmentCols);
        const shipmentId = shipmentResult.insertId;

        if (elements && Array.isArray(elements) && elements.length > 0) {
            for (const element of elements) {
                if (element.description && element.quantity) {
                    await connection.query('INSERT INTO shipment_elements (shipment_id, description, quantity) VALUES (?, ?, ?)', [shipmentId, element.description, element.quantity]);
                }
            }
        }
        
        await connection.query("UPDATE counters SET currentNumber = ? WHERE name = 'shipmentCounter'", [newCount]);
        await connection.commit();
        res.status(201).json({ message: 'Shipment created successfully!', trackingNumber });
    } catch (error) {
        await connection.rollback();
        console.error("Error creating shipment:", error);
        res.status(500).json({ message: 'Error creating shipment record.', error: error.message });
    } finally {
        connection.release();
    }
});

// Other CRUD routes would follow a similar pattern of replacing dbQuery/dbExecute
// ...

// --- PDF Generation Routes (No database changes, only logo path) ---
apiRouter.get('/shipments/:trackingNumber/waybill', async (req, res) => {
    const { trackingNumber } = req.params;
    try {
        const shipments = await dbQuery('SELECT * FROM shipments WHERE trackingNumber = ?', [trackingNumber]);
        if (shipments.length === 0) return res.status(404).send('Shipment not found');
        const shipment = shipments[0];

        const elements = await dbQuery('SELECT * FROM shipment_elements WHERE shipment_id = ?', [shipment.id]);
        const settingsRows = await dbQuery('SELECT `key`, `value` FROM settings');
        const settings = settingsRows.reduce((acc, row) => ({ ...acc, [row.key]: row.value }), {});
        const jobDetailsRows = shipment.associatedJobNo ? await dbQuery('SELECT * FROM chaseJobs WHERE jobNo = ?', [shipment.associatedJobNo]) : [];
        const jobDetails = jobDetailsRows.length > 0 ? jobDetailsRows[0] : null;

        
        const pdfDoc = await PDFDocument.create();
        let currentPage = pdfDoc.addPage();
        const { width, height } = currentPage.getSize();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        const padding = 40;
        let y = height - padding;

        const wrapText = (text, f, fontSize, maxWidth) => {
            const sanitizedText = text ? String(text).replace(/(\r\n|\n|\r)/gm, " ") : "";
            const words = sanitizedText.split(' ');
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
            const logoPath = path.resolve(process.cwd(), 'EB logo.jpg');
            if (fs.existsSync(logoPath)) {
                const imageBytes = fs.readFileSync(logoPath);
                const logoImage = await pdfDoc.embedJpg(imageBytes);
                const logoDims = logoImage.scale(0.25);
                currentPage.drawImage(logoImage, { x: padding, y: y - logoDims.height + 20, width: logoDims.width, height: logoDims.height });
                logoBottomY = y - logoDims.height;
            } else {
                console.log(`Logo not found at path: ${logoPath}`);
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
            currentPage.drawText(`Courier Charge: R ${parseFloat(shipment.courier_charge).toFixed(2)}`, { x: padding + 10, y: y - 80, font: boldFont, size: 10 });
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
// ... Other routes need conversion ...

app.use('/api', apiRouter);


// --- Server Start ---
const startServer = async () => {
    try {
        await initializeDatabase();

        app.use(express.static(path.join(__dirname)));

        app.get(/^(?!\/api).*/, (req, res) => {
            res.sendFile(path.join(__dirname, 'index.html'));
        });

        app.listen(PORT, HOST, async () => {
            console.log(`✅ Server is running on http://localhost:${PORT}`);
            
            const users = await dbQuery('SELECT * FROM users WHERE username = ?', ['Admin']);
            if (users.length === 0) {
                const hashedPassword = await bcrypt.hash('Admin', 10);
                await dbExecute('INSERT INTO users (username, password) VALUES (?, ?)', ['Admin', hashedPassword]);
                console.log('Default user "Admin" created with password "Admin".');
            }
        });

    } catch (error) {
        console.error('❌ Fatal error during server startup:');
        console.error(error);
        process.exit(1);
    }
};

startServer();

