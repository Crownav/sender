const express = require('express');
const nodemailer = require('nodemailer');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Global state
let emailQueue = [];
let isSending = false;
let currentStats = { total: 0, sent: 0, failed: 0, current: 0 };

// WebSocket broadcast
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// ✅ FIXED: Create SMTP transporter with modern TLS settings
function createTransporter(smtpConfig) {
  const security = smtpConfig.security.toLowerCase();
  const isSSL = security === 'ssl';
  const isTLS = security === 'tls';
  
  return nodemailer.createTransport({
    host: smtpConfig.host,
    port: parseInt(smtpConfig.port),
    secure: isSSL, // true for 465, false for 587
    auth: {
      user: smtpConfig.username,
      pass: smtpConfig.password
    },
    // ✅ Modern TLS config - removed insecure SSLv3
    tls: {
      rejectUnauthorized: false, // Keep false if using self-signed certs
      minVersion: 'TLSv1.2'      // ✅ Require modern TLS
    },
    // ✅ Increased timeouts for cloud environments
    connectionTimeout: 30000,    // 30 seconds
    socketTimeout: 30000,        // 30 seconds
    gsocketTimeout: 30000
  });
}

// ✅ FIXED: Send email with retry logic
async function sendEmail(smtpConfig, emailData, attachmentPath, retryCount = 0) {
  const maxRetries = 2;
  
  try {
    const transporter = createTransporter(smtpConfig);
    
    const mailOptions = {
      from: {
        name: emailData.senderName || 'Sender',
        address: emailData.senderEmail
      },
      to: emailData.recipient,
      subject: emailData.subject,
      replyTo: emailData.replyTo,
      priority: emailData.priority || 'normal',
      charset: emailData.charset || 'UTF-8'
    };

    if (emailData.isHtml) {
      mailOptions.html = emailData.message;
    } else {
      mailOptions.text = emailData.message;
    }

    if (attachmentPath) {
      mailOptions.attachments = [{ path: attachmentPath }];
    }

    if (emailData.useBcc && emailData.bccList && emailData.bccList.length > 0) {
      mailOptions.bcc = emailData.bccList;
    }

    const info = await transporter.sendMail(mailOptions);
    return info;
    
  } catch (error) {
    // ✅ Retry on timeout/network errors
    if (retryCount < maxRetries && 
        (error.code === 'ETIMEDOUT' || error.code === 'ESOCKETTIMEDOUT' || error.message.includes('Timeout'))) {
      console.log(`⏳ Retry ${retryCount + 1}/${maxRetries} for ${emailData.recipient}`);
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
      return sendEmail(smtpConfig, emailData, attachmentPath, retryCount + 1);
    }
    throw error;
  }
}

// Process email queue
async function processQueue(config) {
  isSending = true;
  const smtpList = config.smtpList;
  let smtpIndex = 0;
  let emailsSentOnCurrentSmtp = 0;
  let totalEmailsSent = 0;

  broadcast({ type: 'status', message: 'Starting email campaign...' });

  for (let i = 0; i < emailQueue.length; i++) {
    if (!isSending) {
      broadcast({ type: 'status', message: 'Sending stopped by user' });
      break;
    }

    const email = emailQueue[i];
    currentStats.current = i + 1;

    // Rotate SMTP
    if (emailsSentOnCurrentSmtp >= config.changeSmtpEvery && config.changeSmtpEvery > 0) {
      smtpIndex = (smtpIndex + 1) % smtpList.length;
      emailsSentOnCurrentSmtp = 0;
      broadcast({ type: 'smtp_rotate', index: smtpIndex });
    }

    const currentSmtp = smtpList[smtpIndex];

    try {
      // Reconnect if needed
      if (config.reconnectAfter > 0 && totalEmailsSent > 0 && totalEmailsSent % config.reconnectAfter === 0) {
        broadcast({ type: 'status', message: `Reconnecting SMTP... (${totalEmailsSent} emails sent)` });
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await sendEmail(currentSmtp, email, config.attachmentPath);
      
      currentStats.sent++;
      emailsSentOnCurrentSmtp++;
      totalEmailsSent++;

      broadcast({
        type: 'email_sent',
        email: email.recipient,
        progress: {
          current: i + 1,
          total: emailQueue.length,
          percentage: Math.round(((i + 1) / emailQueue.length) * 100)
        },
        stats: currentStats
      });

      // Pause between emails
      if (config.pauseSeconds > 0 && emailsSentOnCurrentSmtp % config.pauseEvery === 0) {
        broadcast({ type: 'status', message: `Pausing for ${config.pauseSeconds} seconds...` });
        await new Promise(resolve => setTimeout(resolve, config.pauseSeconds * 1000));
      }

    } catch (error) {
      currentStats.failed++;
      
      // ✅ Better error logging
      const errorMsg = error.code ? `[${error.code}] ${error.message}` : error.message;
      broadcast({
        type: 'email_failed',
        email: email.recipient,
        error: errorMsg,
        stats: currentStats
      });
      
      console.error(`❌ Failed to send to ${email.recipient}:`, {
        code: error.code,
        message: error.message,
        command: error.command,
        response: error.response
      });
    }
  }

  isSending = false;
  broadcast({
    type: 'completed',
    stats: currentStats,
    message: 'Email campaign completed!'
  });
}

// API Routes
app.post('/api/start', upload.single('attachment'), async (req, res) => {
  try {
    const config = JSON.parse(req.body.config);
    
    // Parse recipients
    const recipients = config.recipients.split('\n').map(e => e.trim()).filter(e => e);

    // Parse SMTP list
    const smtpList = config.smtpList.split('\n').map(line => {
      const parts = line.split('|');
      return {
        host: parts[0],
        username: parts[1],
        password: parts[2],
        port: parts[3] || '465',
        security: parts[4] || 'SSL'
      };
    }).filter(s => s.host && s.username && s.password);

    if (smtpList.length === 0) {
      return res.status(400).json({ error: 'No valid SMTP servers configured' });
    }

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'No recipients specified' });
    }

    // Build email queue
    emailQueue = recipients.map(recipient => ({
      recipient,
      senderEmail: config.senderEmail,
      senderName: config.senderName,
      replyTo: config.replyTo,
      subject: config.subject,
      message: config.message,
      isHtml: config.isHtml === 'true',
      priority: config.priority,
      charset: config.charset,
      useBcc: config.useBcc === 'true',
      bccList: config.useBcc === 'true' ? recipients.filter(r => r !== recipient) : []
    }));

    currentStats = {
      total: emailQueue.length,
      sent: 0,
      failed: 0,
      current: 0
    };

    const processConfig = {
      smtpList,
      changeSmtpEvery: parseInt(config.changeSmtpEvery) || 1,
      pauseSeconds: parseInt(config.pauseSeconds) || 0,
      pauseEvery: parseInt(config.pauseEvery) || 1,
      reconnectAfter: parseInt(config.reconnectAfter) || 0,
      attachmentPath: req.file ? req.file.path : null
    };

    // Start processing in background
    processQueue(processConfig);

    res.json({ success: true, message: 'Email sending started', total: emailQueue.length });
  } catch (error) {
    console.error('Start error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  isSending = false;
  res.json({ success: true, message: 'Stopping email sender...' });
});

app.get('/api/stats', (req, res) => {
  res.json({
    isSending,
    stats: currentStats,
    queueLength: emailQueue.length
  });
});

// WebSocket connection
wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.on('close', () => console.log('Client disconnected'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Email Sender running on http://localhost:${PORT}`);
});