require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { requireActivation } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4000;

// Find this PC's local network IP (the address other PCs on the same
// Wi-Fi/LAN can use to reach this server). Skips loopback and virtual
// adapters, picks the first real IPv4 address it finds.
function getLocalNetworkIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// License routes are open — they're how activation happens in the first place
app.use('/api/license', require('./routes/license'));

// Everything else requires the app to be activated first
app.use('/api/cbt', requireActivation, require('./routes/cbt'));
app.use('/api/teachers', requireActivation, require('./routes/teachers'));

app.get('/api/health', (req, res) => res.json({ status: 'ok', mode: 'offline-cbt' }));
app.get('/api/network-info', (req, res) => {
  res.json({ ip: getLocalNetworkIP(), port: PORT });
});

const CLIENT_DIR = path.join(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR));
app.get('/', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'admin.html')));
app.get('/student', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'student.html')));
app.get('/teacher', (req, res) => res.sendFile(path.join(CLIENT_DIR, 'teacher.html')));

// Listen on 0.0.0.0 (all network interfaces), not just localhost — this is
// what allows other PCs on the same Wi-Fi/LAN to reach this server using
// this machine's IP address, which the separate Student Client app needs.
app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalNetworkIP();
  console.log(`\n🖥️  Offline CBT running`);
  console.log(`   On this PC:        http://localhost:${PORT}/`);
  if (ip) {
    console.log(`   On the network:    http://${ip}:${PORT}/`);
    console.log(`   (Give this IP address to the Student Client app: ${ip})`);
  } else {
    console.log(`   ⚠️  Could not detect a network IP. Make sure this PC is connected to Wi-Fi/LAN.`);
  }
  console.log('');
});

module.exports = app;
