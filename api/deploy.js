const AdmZip = require('adm-zip');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// In-memory storage
let deploymentData = new Map();

module.exports = async (req, res) => {
    // Set CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { name, fileData, fileName } = req.body;

        // Quota check
        if (name === 'quota-check') {
            const clientId = getClientId(req);
            const quotaInfo = getQuotaInfo(clientId);
            const response = { remainingQuota: quotaInfo.remaining };
            if (quotaInfo.cooldownUntil > Date.now()) {
                response.cooldown = true;
                response.remainingSeconds = Math.ceil((quotaInfo.cooldownUntil - Date.now()) / 1000);
            }
            return res.status(200).json(response);
        }

        // Validasi
        if (!name || !fileData || !fileName) {
            return res.status(400).json({ error: 'Data tidak lengkap' });
        }
        if (!/^[a-z0-9-]+$/.test(name)) {
            return res.status(400).json({ error: 'Nama hanya huruf kecil, angka, tanda hubung' });
        }

        // Cek quota
        const clientId = getClientId(req);
        const quotaInfo = getQuotaInfo(clientId);
        if (quotaInfo.cooldownUntil > Date.now()) {
            const remainingSeconds = Math.ceil((quotaInfo.cooldownUntil - Date.now()) / 1000);
            return res.status(429).json({
                error: 'Cooldown aktif',
                cooldown: true,
                remainingSeconds,
                remainingQuota: quotaInfo.remaining
            });
        }
        if (quotaInfo.remaining <= 0) {
            return res.status(429).json({ error: 'Quota habis', remainingQuota: 0 });
        }

        // ======== FIX DISINI: PROSES FILE YANG BENAR ========
        let files = [];

        if (fileName.toLowerCase().endsWith('.zip')) {
            // Extract ZIP
            const zipBuffer = Buffer.from(fileData, 'base64');
            const zip = new AdmZip(zipBuffer);
            const zipEntries = zip.getEntries();
            
            for (const entry of zipEntries) {
                if (!entry.isDirectory && isSafeFile(entry.entryName)) {
                    const fileBuffer = entry.getData();
                    files.push({
                        filepath: entry.entryName,
                        content: fileBuffer.toString('base64'), // Encode ke base64 untuk Vercel
                        isBuffer: false
                    });
                }
            }

            if (!files.some(f => f.filepath.toLowerCase() === 'index.html')) {
                return res.status(400).json({ error: 'ZIP harus ada index.html' });
            }
            
        } else if (fileName.toLowerCase().endsWith('.html') || fileName.toLowerCase().endsWith('.htm')) {
            // File HTML: fileData SUDAH base64 dari frontend, langsung pakai
            files.push({
                filepath: 'index.html',
                content: fileData,  // LANGSUNG fileData (sudah base64)
                isBuffer: false
            });
        } else {
            return res.status(400).json({ error: 'Hanya file .html/.htm atau .zip' });
        }

        // Deploy via Vercel API
        const token = process.env.VERCEL_TOKEN;
        if (!token) {
            return res.status(500).json({ error: 'Token Vercel tidak ditemukan' });
        }

        // Format untuk Vercel API
        const vercelFiles = files.map(f => ({
            file: f.filepath,
            data: f.content  // Sudah base64
        }));

        try {
            const deploymentResponse = await axios.post(
                'https://api.vercel.com/v13/deployments?skipAutoDetectionConfirmation=1',
                {
                    name: name,
                    files: vercelFiles,
                    projectSettings: {
                        framework: null,
                        buildCommand: null,
                        outputDirectory: null,
                        installCommand: null
                    },
                    target: 'production'
                },
                {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: 30000
                }
            );

            // Update quota
            quotaInfo.remaining--;
            quotaInfo.lastDeployment = Date.now();
            quotaInfo.cooldownUntil = Date.now() + (5 * 60 * 1000);
            saveQuotaInfo(clientId, quotaInfo);

            // Return URL
            const deployment = deploymentResponse.data;
            const url = deployment.url 
                ? `https://${deployment.url}` 
                : `https://${name}.vercel.app`;
            
            return res.status(200).json({
                success: true,
                url: url,
                deploymentId: deployment.id,
                remainingQuota: quotaInfo.remaining
            });

        } catch (deployError) {
            console.error('Vercel API Error:', deployError.response?.data || deployError.message);
            
            // Update quota jika error karena nama sudah dipakai
            if (deployError.response?.data?.error?.code === 'name_already_exists' || 
                deployError.response?.data?.error?.message?.toLowerCase().includes('already exists')) {
                
                quotaInfo.remaining--;
                saveQuotaInfo(clientId, quotaInfo);
                
                return res.status(400).json({
                    error: 'Nama sudah digunakan, coba nama lain',
                    remainingQuota: quotaInfo.remaining
                });
            }
            
            return res.status(500).json({ 
                error: deployError.response?.data?.error?.message || 'Deployment gagal' 
            });
        }

    } catch (error) {
        console.error('General error:', error);
        return res.status(500).json({ 
            error: 'Terjadi kesalahan server: ' + error.message 
        });
    }
};

// Helper functions
function getClientId(req) {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '';
    return crypto.createHash('md5').update(ip + userAgent).digest('hex');
}

function getQuotaInfo(clientId) {
    const now = Date.now();
    const today = new Date().toDateString();
    
    if (!deploymentData.has(clientId)) {
        deploymentData.set(clientId, {
            remaining: 50,
            lastReset: today,
            lastDeployment: null,
            cooldownUntil: 0
        });
    }
    
    const data = deploymentData.get(clientId);
    if (data.lastReset !== today) {
        data.remaining = 50;
        data.lastReset = today;
        data.cooldownUntil = 0;
    }
    
    // Cleanup
    deploymentData.forEach((value, key) => {
        if (now - (value.lastDeployment || now) > 24 * 60 * 60 * 1000) {
            deploymentData.delete(key);
        }
    });
    
    return data;
}

function saveQuotaInfo(clientId, info) {
    deploymentData.set(clientId, info);
}

function isSafeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const safeExtensions = ['.html', '.htm', '.css', '.js', '.json', '.txt', '.md', 
                           '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico',
                           '.woff', '.woff2', '.ttf', '.eot', '.webp'];
    
    if (!safeExtensions.includes(ext)) return false;
    if (filePath.includes('..') || filePath.includes('//')) return false;
    
    const basename = path.basename(filePath);
    if (basename.startsWith('.') && basename !== '.htaccess') return false;
    
    return true;
}
