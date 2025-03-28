const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { Buffer } = require('buffer');
const WebSocket = require('ws');
const http = require('http');
const net = require('net');
const xlsx = require('xlsx');
const { exec } = require('child_process');
require('dotenv').config();
const employees = require('./Employee.js').default;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
const allowedFrontendHosts = process.env.ALLOWED_FRONTEND_HOSTS?.split(',').map(ip => ip.trim()) || [];
const allowedBackendHosts = process.env.ALLOWED_BACKEND_HOSTS?.split(',').map(ip => ip.trim()) || [];

// Update CORS configuration
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);

        const allowedOrigins = [
            'http://localhost:5173',
            'http://127.0.0.1:5173',
            'http://0.0.0.0:5173',
            'http://Dynvms:5173',
            ...allowedFrontendHosts.map(host => `http://${host}:5173`)
        ];

        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            console.log('Rejected Origin:', origin);
            console.log('Allowed Origins:', allowedOrigins);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Add OPTIONS handling for preflight requests
app.options('*', cors());

// MongoDB Connection
const connectToMongoDB = async (retries = 5) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`MongoDB connection attempt ${attempt}/${retries}`);
            await mongoose.connect(process.env.MONGODB_URI, {
                useNewUrlParser: true,
                useUnifiedTopology: true,
                serverSelectionTimeoutMS: 5000, // Timeout after 5s instead of 30s
                socketTimeoutMS: 45000, // Close sockets after 45s
                family: 4 // Use IPv4, skip trying IPv6
            });
            console.log('Connected to MongoDB successfully');
            return;
        } catch (err) {
            console.error(`MongoDB connection attempt ${attempt} failed:`, err);
            if (attempt === retries) {
                console.error('All MongoDB connection attempts failed.');
                process.exit(1); // Exit if all retries failed
            }
            // Wait for 5 seconds before retrying
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
};

// Initialize MongoDB connection
connectToMongoDB().catch(err => {
    console.error('Fatal MongoDB connection error:', err);
    process.exit(1);
});

// Storage Configuration for Visitor Photos
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

// Visitor Schema
const visitorSchema = new mongoose.Schema({
    fullname: { type: String, required: true },
    email: { type: String },
    phone: { type: String, required: true },
    purpose: { type: String, required: true },
    visitingMember: { type: String, required: true },
    visitTime: { type: String, required: true },
    visitDate: { type: String, required: true },
    photo: {
        data: Buffer,
        contentType: String
    },
    status: {
        type: String,
        enum: ['pending', 'approved', 'rejected', 'checked-in', 'completed'],
        default: 'pending'
    },
    employerApproval: { type: Boolean, default: false },
    checkedIn: { type: Boolean, default: false },
    checkedOut: { type: Boolean, default: false },
    checkInTime: { type: Date },
    checkOutTime: { type: Date },
    createdAt: { type: Date, default: Date.now },
    isPreviousVisit: { type: Boolean, default: false },
    previousVisitId: { type: String },
});

const Visitor = mongoose.model('Visitor', visitorSchema);

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Update IPMsg notification function to send only basic notification
async function sendIPMsgNotification(ipAddress, message) {
    return new Promise((resolve, reject) => {
        const ipmsgPath = path.join(__dirname, 'IPMsg.exe');
        // Simple notification message without links
        const escapedMessage = message.replace(/"/g, '\\"');
        const command = `"${ipmsgPath}" /MSG ${ipAddress} "${escapedMessage}"`;

        exec(command, { windowsHide: true }, (error, stdout, stderr) => {
            if (error) {
                console.error('IPMsg error:', error);
                // Don't reject on error, just log it
                console.log('Continuing despite IPMsg error');
                resolve();
                return;
            }

            if (stderr) {
                console.error('IPMsg stderr:', stderr);
                console.log('Continuing despite IPMsg stderr');
                resolve();
                return;
            }

            console.log('IPMsg sent successfully to:', ipAddress);
            console.log('IPMsg output:', stdout);
            resolve();
        });
    });
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('close', () => console.log('Client disconnected'));
});

// Function to broadcast updates to all connected clients
const broadcastUpdate = (data) => {
    const serverConfig = getServerConfig();

    if (serverConfig.isMainServer) {
        // Main server broadcasts to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'BROADCAST',
                    data: data,
                    source: 'main-server'
                }));
            }
        });
    } else {
        // Secondary servers only broadcast locally and notify main server
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(data));
            }
        });
    }
};

// Add this new function to get system IP addresses
const getSystemIPAddresses = () => {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const results = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
            if (net.family === 'IPv4' && !net.internal) {
                results.push(net.address);
            }
        }
    }
    return results;
};
// Add near the top with other utility functions
const getServerIPs = () => {
    const serverIPs = process.env.SERVER_IPS?.split(',') || [];
    const backendURLs = process.env.BACKEND_URLS?.split(',') || [];

    return serverIPs.map((ip, index) => ({
        ip: ip.trim(),
        url: backendURLs[index]?.trim() || `http://${ip.trim()}:${process.env.PORT}`
    }));
};

// Add near the top with other utility functions
const getServerConfig = () => {
    const isMainServer = getSystemIPAddresses().includes(process.env.MAIN_SERVER_IP);
    const secondaryIPs = process.env.SECONDARY_IPS?.split(',') || [];
    const secondaryURLs = process.env.SECONDARY_URLS?.split(',') || [];
    // Main_server_API
    return {
        isMainServer,
        mainServer: {
            ip: process.env.MAIN_SERVER_IP,
            url: process.env.MAIN_SERVER_URL
        },
        secondaryServers: secondaryIPs.map((ip, index) => ({
            ip: ip.trim(),
            url: secondaryURLs[index]?.trim()
        }))
    };
};

// Update the getClientIp function to better handle IPv4 addresses
const getClientIp = (req) => {
    // Get the raw IP address
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
        req.socket?.remoteAddress;

    // Handle IPv6 format of IPv4 addresses (e.g., ::ffff:192.168.1.74)
    if (rawIp && rawIp.includes('::ffff:')) {
        return rawIp.split('::ffff:')[1];
    }

    // Handle local IPv6 address
    if (rawIp === '::1') {
        return '127.0.0.1';
    }

    return rawIp;
};

// Add helper function for IST conversion at the top with other utility functions
const getISTTime = () => {
    const now = new Date();
    return new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // Add 5 hours and 30 minutes for IST
};

// Add this utility function near other utility functions
const isAllowedEmployeeIP = (ip) => {
    const allowedIPs = process.env.ALLOWED_EMPLOYEE_IPS?.split(',') || [];
    return allowedIPs.includes(ip);
};

// Add this helper function near other utility functions
const formatISTTimeForReport = (timestamp) => {
    if (!timestamp) return 'N/A';
    return new Date(timestamp).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'short',
        timeStyle: 'medium'
    });
};

// Add near top with other utility functions
const getISTDateTime = () => {
    return new Date().toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'short',
        timeStyle: 'medium'
    });
};

const formatISTDateTime = (date) => {
    if (!date) return 'N/A';
    try {
        const options = {
            timeZone: 'Asia/Kolkata',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        };
        return new Date(date).toLocaleString('en-IN', options);
    } catch (error) {
        console.error('Error formatting date:', error);
        return 'N/A';
    }
};

// Remove the IST-specific utility functions and replace with simple date formatter
const formatDateTime = (date) => {
    if (!date) return 'N/A';
    return new Date(date).toLocaleString('en-US');
};

// Add this near other utility functions
const sendSMS = async (phone, message) => {
    try {
        const apiKey = process.env.SMS_API_KEY;
        const response = await fetch(`${process.env.SMS_API_URL}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
                phone: phone,
                msg: message
            })
        });

        const data = await response.json();

        if (data.success) {
            console.log('SMS API Response:', JSON.stringify(data));
            console.log('SMS notification sent to:', phone);
            console.log('Remaining credits:', data.data.credits);
            return true;
        } else {
            console.error('SMS sending failed:', data.error);
            return false;
        }
    } catch (error) {
        console.error('Error sending SMS:', error);
        throw error;
    }
};

// Routes

// Register new visitor
app.post('/api/visitors', upload.single('photo'), async (req, res) => {
    try {
        const {
            fullname,
            email,
            phone,
            purpose,
            visitingMember,
            visitTime,
            visitDate,
            isPreviousVisit,
            previousVisitId,
        } = req.body;

        // Get employee directly from Employee.js array
        const employee = employees.find(emp => emp.name === visitingMember);
        if (!employee) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found'
            });
        }

        // Handle photo data
        let photoData = null;
        if (req.file) {
            photoData = {
                data: req.file.buffer,
                contentType: req.file.mimetype
            };
        }

        // If no photo was uploaded, the photoData will remain null
        // The frontend will handle displaying the default profile icon

        const visitor = new Visitor({
            fullname,
            email,
            phone,
            purpose,
            visitingMember,
            visitTime,
            visitDate,
            photo: photoData,
            isPreviousVisit: isPreviousVisit === "true",
            previousVisitId,
        });

        await visitor.save();

        // Send simple IPMsg notification
        try {
            const ipMsgMessage = `[VMS] New visit request found from ${fullname}! Please check your email for details.`;
            await sendIPMsgNotification(employee.ipmsg, ipMsgMessage);
            console.log('IPMsg notification sent to:', employee.ipmsg);
        } catch (ipMsgError) {
            console.error('IPMsg notification failed:', ipMsgError.message);
        }

        // Send detailed email with approval/rejection links
        const emailSubject = isPreviousVisit === "true"
            ? 'New Visit Request from Returning Visitor - Action Required'
            : 'New Visit Request - Action Required';

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: employee.email,
            subject: emailSubject,
            html: `
                <h2>New Visit Request</h2>
                <p>A visitor has requested to meet you:</p>
                <ul>
                    <li>Name: ${fullname}</li>
                    <li>Email: ${email || 'N/A'}</li>
                    <li>Phone: ${phone}</li>
                    <li>Purpose: ${purpose}</li>
                    <li>Visit Time: ${visitTime}</li>
                    <li>Visit Date: ${visitDate}</li>
                </ul>
                <div style="margin-top: 20px;">
                    <p style="color: #666; margin-bottom: 10px;">
                        Please use the links below to approve or reject this visit request.
                        (Note: Links will only work from your assigned computer IP: ${employee.ipmsg})
                    </p>
                    <div style="margin-top: 15px;">
                       <a href="http://dynvms:5000/api/result/approve/${visitor._id}?ip=${employee.ipmsg}"
                           style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; margin-right: 10px; border-radius: 4px;">
                           Approve Visit
                        </a>
                        <a href="http://dynvms:5000/api/result/reject/${visitor._id}?ip=${employee.ipmsg}"
                           style="background-color: #f44336; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                           Reject Visit
                        </a>
                    </div>
                </div>
            `,
            attachments: photoData ? [{
                filename: 'visitor-photo.jpg',
                content: photoData.data
            }] : []
        };
        //
        await transporter.sendMail(mailOptions);

        // Broadcast to WebSocket clients
        broadcastUpdate({
            type: 'NEW_VISITOR',
            visitor: {
                ...visitor.toObject(),
                photoUrl: visitor.photo ? `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}` : null
            }
        });

        res.status(201).json({
            success: true,
            message: 'Visitor registered successfully',
            visitor: visitor
        });

    } catch (error) {
        console.error('Error registering visitor:', error);
        res.status(500).json({
            success: false,
            message: 'Error registering visitor',
            error: error.message
        });
    }
});

// Update the report generation code
app.post('/api/generatereport', async (req, res) => {
    try {
        const { reportType, dateRange } = req.body;
        let visitors;

        if (reportType === 'specific') {
            const [startDate, endDate] = dateRange;
            visitors = await Visitor.find({
                visitDate: {
                    $gte: startDate,
                    $lte: endDate
                }
            }).sort({ visitDate: 1 });
        } else if (reportType === 'monthly') {
            const currentDate = new Date();
            const firstDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
            const lastDayOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);

            visitors = await Visitor.find({
                visitDate: {
                    $gte: firstDayOfMonth.toISOString().split('T')[0],
                    $lte: lastDayOfMonth.toISOString().split('T')[0]
                }
            }).sort({ visitDate: 1 });
        }

        // Create workbook and worksheet
        const workbook = xlsx.utils.book_new();
        const worksheet = xlsx.utils.json_to_sheet(visitors.map(visitor => {
            // Calculate duration in regular time
            let duration = 'N/A';
            if (visitor.checkInTime && visitor.checkOutTime) {
                const checkIn = new Date(visitor.checkInTime);
                const checkOut = new Date(visitor.checkOutTime);
                const durationMs = checkOut - checkIn;
                const minutes = Math.round(durationMs / (1000 * 60));
                duration = `${minutes} minutes`;
            }

            return {
                'Name': visitor.fullname || 'N/A',
                'Email': visitor.email || 'N/A',
                'Phone': visitor.phone || 'N/A',
                'Purpose of Visit': visitor.purpose || 'N/A',
                'Person Visited': visitor.visitingMember || 'N/A',
                'Visit Date': visitor.visitDate || 'N/A',
                'Visit Time': visitor.visitTime || 'N/A',
                'Check-in Status': visitor.checkedIn ? 'Checked In' : 'Not Checked In',
                'Check-in Time': visitor.checkInTime ? formatDateTime(visitor.checkInTime) : 'Not Checked In',
                'Check-out Status': visitor.checkedOut ? 'Checked Out' : 'Not Checked Out',
                'Check-out Time': visitor.checkOutTime ? formatDateTime(visitor.checkOutTime) : 'Not Checked Out',
                'Current Status': visitor.status ? visitor.status.toUpperCase() : 'N/A',
                'Duration': duration
            };
        }));

        // Set column widths
        worksheet['!cols'] = [
            { wch: 20 }, // Name
            { wch: 25 }, // Email
            { wch: 15 }, // Phone
            { wch: 20 }, // Purpose
            { wch: 20 }, // Person Visited
            { wch: 12 }, // Visit Date
            { wch: 12 }, // Visit Time
            { wch: 15 }, // Check-in Status
            { wch: 20 }, // Check-in Time
            { wch: 15 }, // Check-out Status
            { wch: 20 }, // Check-out Time
            { wch: 15 }, // Current Status
            { wch: 15 }  // Duration
        ];

        // Add worksheet to workbook
        xlsx.utils.book_append_sheet(workbook, worksheet, 'Visitors Report');

        // Generate buffer and send response
        const excelBuffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=visitors-report-${reportType}-${new Date().toISOString().split('T')[0]}.xlsx`);
        res.send(Buffer.from(excelBuffer));

    } catch (error) {
        console.error('Error generating report:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating report',
            error: error.message
        });
    }
});

// Get visitor by ID
app.get('/api/visitors/:id', async (req, res) => {
    try {
        const visitor = await Visitor.findById(req.params.id);
        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        const visitorResponse = visitor.toObject();
        if (visitor.photo) {
            visitorResponse.photoUrl = `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}`;
            delete visitorResponse.photo;
        }

        res.json({ success: true, visitor: visitorResponse });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching visitor',
            error: error.message
        });
    }
});
//get image from database for previous visit

// Update visitor status (for employee approval)
app.patch('/api/visitors/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const visitor = await Visitor.findById(req.params.id);

        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        visitor.status = status;
        visitor.employerApproval = status === 'approved';
        await visitor.save();

        // Send WebSocket update to all clients
        broadcastUpdate({
            type: 'STATUS_UPDATE',
            visitorId: visitor._id,
            status: status,
            employerApproval: visitor.employerApproval
        });

        // Send email notification to visitor about approval/rejection
        if (visitor.email) {
            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: visitor.email,
                subject: `Visit Request ${status.charAt(0).toUpperCase() + status.slice(1)}`,
                html: `
                    <h2>Visit Request ${status.charAt(0).toUpperCase() + status.slice(1)}</h2>
                    <p>Your visit request for ${visitor.visitDate} at ${visitor.visitTime} has been ${status} by ${visitor.visitingMember}.</p>
                    ${status === 'approved' ? '<p>Please proceed to the reception desk at the scheduled time.</p>' : ''}
                `
            };

            await transporter.sendMail(mailOptions);
        }

        res.json({
            success: true,
            message: `Visitor status updated to ${status}`,
            visitor
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error updating visitor status',
            error: error.message
        });
    }
});

app.put('/api/visitors/:id/status', async (req, res) => {
    try {
        const { status } = req.body;
        const visitor = await Visitor.findById(req.params.id);

        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        const oldStatus = visitor.status;
        visitor.status = status.toLowerCase();

        // Update check-in/out times to use regular timestamps
        if (status.toLowerCase() === 'checked-in') {
            visitor.checkedIn = true;
            visitor.checkInTime = new Date();
        } else if (status.toLowerCase() === 'completed') {
            visitor.checkedOut = true;
            visitor.checkOutTime = new Date();

            // Send thank you email if visitor has provided email
            if (visitor.email) {
                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: visitor.email,
                    subject: 'Thank You for Visiting DynPro India',
                    html: `
                        <div style="text-align: center; font-family: Arial, sans-serif;">
                            <img src="https://www.dynproindia.com/wp-content/uploads/2022/01/dynpro-logo-2-1-e1641987897332-1.png" 
                                 alt="DynPro Logo" 
                                 style="max-width: 200px; margin-bottom: 20px;">
                            <h2 style="color: #333;">Thank You for Visiting DynPro India</h2>
                            <p style="color: #666;">We hope you had a pleasant visit.</p>
                            <p style="color: #666;">Visit Details:</p>
                            <div style="background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 20px 0;">
                                <p><strong>Date:</strong> ${visitor.visitDate}</p>
                                <p><strong>Visit Time:</strong> ${visitor.visitTime}</p>
                                <p><strong>Check-in Time:</strong> ${visitor.checkInTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
                                <p><strong>Check-out Time:</strong> ${visitor.checkOutTime.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
                                <p><strong>Purpose:</strong> ${visitor.purpose}</p>
                                <p><strong>Person Visited:</strong> ${visitor.visitingMember}</p>
                            </div>
                            <p style="color: #666;">We look forward to welcoming you again!</p>
                        </div>
                    `
                };

                await transporter.sendMail(mailOptions);
            }
        }

        await visitor.save();

        // Broadcast update with complete visitor data
        broadcastUpdate({
            type: 'STATUS_UPDATE',
            visitorId: visitor._id.toString(),
            status: visitor.status,
            oldStatus: oldStatus,
            visitor: {
                id: visitor._id.toString(),
                fullname: visitor.fullname,
                phone: visitor.phone,
                email: visitor.email,
                purpose: visitor.purpose,
                visitDate: visitor.visitDate,
                visitTime: visitor.visitTime,
                status: visitor.status,
                checkedIn: visitor.checkedIn,
                checkedOut: visitor.checkedOut,
                checkInTime: visitor.checkInTime ? formatDateTime(visitor.checkInTime) : null,
                checkOutTime: visitor.checkOutTime ? formatDateTime(visitor.checkOutTime) : null,
                visitingMember: visitor.visitingMember,
                photoUrl: visitor.photo ? `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}` : null
            }
        });

        res.json({
            success: true,
            message: `Visitor status updated to ${status}`,
            visitor: visitor
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error updating visitor status',
            error: error.message
        });
    }
});

// Add a route to get visitor photo
app.get('/api/visitors/:id/photo', async (req, res) => {
    try {
        const visitor = await Visitor.findById(req.params.id);
        if (!visitor || !visitor.photo) {
            return res.status(404).send('No photo found');
        }

        res.set('Content-Type', visitor.photo.contentType);
        res.send(visitor.photo.data);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error fetching photo',
            error: error.message
        });
    }
});

// Add route to get all visitors with photos - Uncomment and update this route
app.get('/api/visitors', async (req, res) => {
    try {
        const visitors = await Visitor.find().sort({ createdAt: -1 }); // Sort by newest first
        const visitorsResponse = visitors.map(visitor => {
            const visitorObj = visitor.toObject();
            if (visitor.photo && visitor.photo.data) {
                visitorObj.photoUrl = `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}`;
                delete visitorObj.photo;
            }
            return {
                id: visitorObj._id,
                fullname: visitorObj.fullname,
                phone: visitorObj.phone,
                email: visitorObj.email,
                purpose: visitorObj.purpose,
                visitingMember: visitorObj.visitingMember,
                visitTime: visitorObj.visitTime,
                visitDate: visitorObj.visitDate,
                status: visitorObj.status,
                employerApproval: visitorObj.employerApproval,
                checkedIn: visitorObj.checkedIn,
                checkedOut: visitorObj.checkedOut,
                checkInTime: visitorObj.checkInTime,
                checkOutTime: visitorObj.checkOutTime,
                photoUrl: visitorObj.photoUrl,
                createdAt: visitorObj.createdAt
            };
        });

        res.json({
            success: true,
            visitors: visitorsResponse
        });
    } catch (error) {
        console.error('Error fetching visitors:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching visitors',
            error: error.message
        });
    }
});

// Add new route for handling email approval/rejection
app.get('/api/result/:action/:id', async (req, res) => {
    try {
        const { action, id } = req.params;
        const { ip: expectedIp } = req.query;

        // First find the visitor to get the employee info
        const visitor = await Visitor.findById(id);
        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        // Find the employee and validate IP matches their assigned IP
        const employee = employees.find(emp => emp.name === visitor.visitingMember);
        if (!employee || employee.ipmsg !== expectedIp) {
            return res.status(403).send(`
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                        </style>
                    </head>
                    <body>
                        <h1>Access Denied</h1>
                        <p>You can only approve/reject visits from your assigned computer.</p>
                        <p>Expected IP: ${employee?.ipmsg}</p>
                    </body>
                </html>
            `);
        }

        // Validate system IP
        const validIp = await getClientIp(req, expectedIp);
        if (!validIp) {
            return res.status(403).send(`
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                            .details { margin-top: 20px; color: #666; }
                        </style>
                    </head>
                    <body>
                        <h1>Access Denied</h1>
                        <p>This action can only be performed from your assigned office computer.</p>
                        <div class="details">
                            <p>System Information:</p>
                            <p>Your IP: ${getClientIp(req)}</p>
                            <p>Required IP: ${expectedIp}</p>
                            <p>Available System IPs: ${getSystemIPAddresses().join(', ')}</p>
                        </div>
                    </body>
                </html>
            `);
        }

        const oldStatus = visitor.status;
        const status = action === 'approve' ? 'approved' : 'rejected';
        visitor.status = status;
        visitor.employerApproval = action === 'approve';
        await visitor.save();

        // Create a consistent visitor object for broadcasting
        const visitorForBroadcast = {
            id: visitor._id.toString(), // Convert ObjectId to string
            fullname: visitor.fullname,
            phone: visitor.phone,
            email: visitor.email,
            purpose: visitor.purpose,
            visitDate: visitor.visitDate,
            visitTime: visitor.visitTime,
            status: status,
            employerApproval: visitor.employerApproval,
            checkedIn: visitor.checkedIn,
            checkedOut: visitor.checkedOut,
            checkInTime: visitor.checkInTime,
            checkOutTime: visitor.checkOutTime,
            visitingMember: visitor.visitingMember
        };

        if (visitor.photo && visitor.photo.data) {
            visitorForBroadcast.photoUrl = `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}`;
        }

        // Broadcast update with consistent data
        broadcastUpdate({
            type: 'STATUS_UPDATE',
            visitorId: visitor._id.toString(), // Convert ObjectId to string
            status: status,
            employerApproval: visitor.employerApproval,
            oldStatus: oldStatus,
            visitor: visitorForBroadcast
        });

        // Send SMS notification
        const smsMessage = `Your visit request for ${visitor.visitDate} has been ${status} by ${visitor.visitingMember}. ${status === 'approved'
            ? 'Please proceed to reception at the scheduled time.'
            : 'Please contact the person for more information.'
            }`;

        try {
            await sendSMS(visitor.phone, smsMessage);
            console.log('SMS notification sent to:', visitor.phone);
        } catch (smsError) {
            console.error('Failed to send SMS:', smsError);
            // Continue execution even if SMS fails
        }

        res.send(`
            <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        h1 { color: ${status === 'approved' ? '#4CAF50' : '#f44336'}; }
                    </style>
                </head>
                <body>
                    <h1>Visit Request ${status.toUpperCase()}</h1>
                    <p>You have successfully ${status} the visit request.</p>
                    <p>You can close this window now.</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error processing approval/rejection:', error);
        res.status(500).send('Error processing your request');
    }
});

// Update IP validation in the approval/rejection endpoint
app.get('/api/result/:action/:id', async (req, res) => {
    try {
        const { action, id } = req.params;
        const { ip: expectedIp } = req.query;

        // Get the actual client IP
        const clientIp = getClientIp(req);
        const systemIPs = getSystemIPAddresses();

        console.log({
            clientIp,
            expectedIp,
            systemIPs,
            headers: req.headers,
            remoteAddress: req.socket?.remoteAddress
        });

        // First find the visitor to get the employee info
        const visitor = await Visitor.findById(id);
        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        // Find the employee
        const employee = employees.find(emp => emp.name === visitor.visitingMember);
        if (!employee || employee.ipmsg !== expectedIp) {
            return res.status(403).send(`
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                            .details { margin-top: 20px; color: #666; }
                        </style>
                    </head>
                    <body>
                        <h1>Access Denied</h1>
                        <p>You can only approve/reject visits from your assigned computer.</p>
                        <div class="details">
                            <p>Your IP: ${clientIp}</p>
                            <p>Required IP: ${expectedIp}</p>
                            <p>System IPs: ${systemIPs.join(', ')}</p>
                        </div>
                    </body>
                </html>
            `);
        }

        // Validate IP matches
        if (!systemIPs.includes(expectedIp) || clientIp !== expectedIp) {
            return res.status(403).send(`
                <html>
                    <head>
                        <style>
                            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                            h1 { color: #f44336; }
                            .details { margin-top: 20px; color: #666; }
                        </style>
                    </head>
                    <body>
                        <h1>Access Denied</h1>
                        <p>This action can only be performed from your assigned office computer.</p>
                        <div class="details">
                            <p>Your IP: ${clientIp}</p>
                            <p>Required IP: ${expectedIp}</p>
                            <p>Available System IPs: ${systemIPs.join(', ')}</p>
                        </div>
                    </body>
                </html>
            `);
        }

        // Rest of the existing approval/rejection code...
        const oldStatus = visitor.status;
        const status = action === 'approve' ? 'approved' : 'rejected';
        visitor.status = status;
        visitor.employerApproval = action === 'approve';
        await visitor.save();

        // Create a consistent visitor object for broadcasting
        const visitorForBroadcast = {
            id: visitor._id.toString(), // Convert ObjectId to string
            fullname: visitor.fullname,
            phone: visitor.phone,
            email: visitor.email,
            purpose: visitor.purpose,
            visitDate: visitor.visitDate,
            visitTime: visitor.visitTime,
            status: status,
            employerApproval: visitor.employerApproval,
            checkedIn: visitor.checkedIn,
            checkedOut: visitor.checkedOut,
            checkInTime: visitor.checkInTime,
            checkOutTime: visitor.checkOutTime,
            visitingMember: visitor.visitingMember
        };

        if (visitor.photo && visitor.photo.data) {
            visitorForBroadcast.photoUrl = `data:${visitor.photo.contentType};base64,${visitor.photo.data.toString('base64')}`;
        }

        // Broadcast update with consistent data
        broadcastUpdate({
            type: 'STATUS_UPDATE',
            visitorId: visitor._id.toString(), // Convert ObjectId to string
            status: status,
            employerApproval: visitor.employerApproval,
            oldStatus: oldStatus,
            visitor: visitorForBroadcast
        });

        // Send SMS notification
        const smsMessage = `Your visit request for ${visitor.visitDate} has been ${status}. ${status === 'approved'
            ? 'Please proceed to checkin.'
            : 'Please contact the person for more information.'
            }`;

        try {
            await sendSMS(visitor.phone, smsMessage);
            console.log('SMS notification sent to:', visitor.phone);
        } catch (smsError) {
            console.error('Failed to send SMS:', smsError);
            // Continue execution even if SMS fails
        }

        res.send(`
            <html>
                <head>
                    <style>
                        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
                        h1 { color: ${status === 'approved' ? '#4CAF50' : '#f44336'}; }
                    </style>
                </head>
                <body>
                    <h1>Visit Request ${status.toUpperCase()}</h1>
                    <p>You have successfully ${status} the visit request.</p>
                    <p>You can close this window now.</p>
                </body>
            </html>
        `);
    } catch (error) {
        console.error('Error processing approval/rejection:', error);
        res.status(500).send('Error processing your request');
    }
});

// Add DELETE route for visitors
app.delete('/api/visitors/:id', async (req, res) => {
    try {
        const visitor = await Visitor.findByIdAndDelete(req.params.id);

        if (!visitor) {
            return res.status(404).json({
                success: false,
                message: 'Visitor not found'
            });
        }

        // Broadcast deletion to all clients
        broadcastUpdate({
            type: 'VISITOR_DELETED',
            visitorId: visitor._id.toString()
        });

        res.json({
            success: true,
            message: 'Visitor deleted successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Error deleting visitor',
            error: error.message
        });
    }
});

// Update the get visitor by phone route to handle errors better
app.get('/api/visitors/phone/:phone', async (req, res) => {
    try {
        const phoneNumber = req.params.phone;
        console.log('Fetching visitor with phone:', phoneNumber);

        if (!phoneNumber || phoneNumber.length !== 10) {
            return res.status(400).json({
                success: false,
                message: 'Invalid phone number format'
            });
        }

        const visits = await Visitor.find({
            phone: phoneNumber,
            status: 'completed'
        })
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();  // Use lean() for better performance

        if (!visits || visits.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No previous visits found with this phone number'
            });
        }

        // Format the response with proper error handling for photo conversion
        const formattedVisits = visits.map(visit => {
            let photoUrl = null;
            if (visit.photo && visit.photo.data && visit.photo.contentType) {
                try {
                    photoUrl = `data:${visit.photo.contentType};base64,${visit.photo.data.toString('base64')}`;
                } catch (error) {
                    console.error('Error converting photo:', error);
                }
            }

            return {
                id: visit._id,
                fullname: visit.fullname || '',
                email: visit.email || '',
                phone: visit.phone || '',
                purpose: visit.purpose || '',
                visitingMember: visit.visitingMember || '',
                status: visit.status || '',
                visitDate: visit.visitDate || '',
                visitTime: visit.visitTime || '',
                photoUrl: photoUrl
            };
        });

        res.json({
            success: true,
            visits: formattedVisits
        });
    } catch (error) {
        console.error('Error fetching visitor history:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching visitor history',
            error: error.message
        });
    }
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        message: 'Something went wrong!',
        error: err.message
    });
});

const PORT = process.env.PORT || 5000;
const HOST = '0.0.0.0'; // Listen on all network interfaces

// Update the server.listen section
server.listen(PORT, HOST, () => {
    console.log(`\nServer running at http://${HOST}:${PORT}`);
    console.log('\nAccess Configuration:');
    console.log('Server accessible from:');
    console.log('- Local: http://localhost:5000');
    console.log('- Network:', `http://${getSystemIPAddresses()[0]}:5000`);
    // console.log('- Custom: http://Dynvms:5000`);

    console.log('\nAllowed IPs:', [...new Set([...allowedFrontendHosts, ...allowedBackendHosts])].join(', '));

    const serverConfig = getServerConfig();
    console.log('\nServer Configuration:');

    if (serverConfig.isMainServer) {
        console.log('Running as MAIN SERVER');
        console.log(`Main Server IP: ${serverConfig.mainServer.ip}`);
        console.log(`Main Server URL: ${serverConfig.mainServer.url}`);
        console.log('\nConnected Secondary Servers:');
        serverConfig.secondaryServers.forEach(server => {
            console.log(`${server.ip} -> ${server.url}`);
        });
    } else {
        console.log('Running as SECONDARY SERVER');
        console.log(`Main Server: ${serverConfig.mainServer.url}`);
        console.log(`Current Server IP: ${getSystemIPAddresses()[0]}`);
    }

    // Log network interfaces
    console.log('\nAvailable Network Interfaces:');
    const networkInterfaces = require('os').networkInterfaces();
    Object.keys(networkInterfaces).forEach((interfaceName) => {
        networkInterfaces[interfaceName].forEach((interface) => {
            if (interface.family === 'IPv4') {
                console.log(`${interfaceName}: ${interface.address}`);
            }
        });
    });
});

// Update WebSocket configuration to connect to main server if this is a secondary server
const setupWebSocket = () => {
    const serverConfig = getServerConfig();

    if (serverConfig.isMainServer) {
        // Main server handles incoming connections
        wss.on('connection', (ws, req) => {
            const clientIp = getClientIp(req);
            console.log(`Client connected from IP: ${clientIp}`);

            ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'SERVER_REGISTRATION') {
                        console.log(`Secondary server registered: ${message.ip}`);
                    }
                } catch (error) {
                    console.error('Error processing WebSocket message:', error);
                }
            });
        });
    } else {
        // Secondary servers connect to main server
        const connectToMainServer = () => {
            // Ensure we have a valid WebSocket URL
            let mainServerWsUrl;
            try {
                const url = new URL(serverConfig.mainServer.url);
                mainServerWsUrl = `ws://${url.hostname}:${url.port}`;
            } catch (error) {
                console.error('Invalid main server URL:', error);
                return;
            }

            console.log('Attempting to connect to main server at:', mainServerWsUrl);
            const mainServerWs = new WebSocket(mainServerWsUrl);

            mainServerWs.on('open', () => {
                console.log('Connected to main server:', mainServerWsUrl);
                mainServerWs.send(JSON.stringify({
                    type: 'SERVER_REGISTRATION',
                    ip: getSystemIPAddresses()[0]
                }));
            });

            mainServerWs.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'BROADCAST') {
                        broadcastUpdate(message.data);
                    }
                } catch (error) {
                    console.error('Error processing message from main server:', error);
                }
            });

            mainServerWs.on('close', () => {
                console.log('Disconnected from main server, attempting to reconnect...');
                setTimeout(connectToMainServer, Number(process.env.WS_RECONNECT_INTERVAL || 5000));
            });

            mainServerWs.on('error', (error) => {
                console.error('WebSocket error:', error);
            });
        };

        // Initial connection
        connectToMainServer();
    }
};

// Call setupWebSocket after server starts
setupWebSocket();

module.exports = app;
