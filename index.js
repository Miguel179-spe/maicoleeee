const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const compression = require('compression');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIGURACIÓN DE IDIOMAS =====
const config = { 
    LANGUAGES: {
        'es': {
            file: 'data_es.json',
            name: 'Español',
            flag: '🇪🇸'
        },
        'en': {
            file: 'data_en.json',
            name: 'English',
            flag: '🇺🇸'
        },
        'pt': {
            file: 'data_pt.json',
            name: 'Português',
            flag: '🇧🇷'
        },
        'fr': {
            file: 'data_fr.json',
            name: 'Français',
            flag: '🇫🇷'
        },
        'de': {
            file: 'data_de.json',
            name: 'Deutsch',
            flag: '🇩🇪'
        },
        'it': {
            file: 'data_it.json',
            name: 'Italiano',
            flag: '🇮🇹'
        }
    },
    DEFAULT_LANGUAGE: 'es'
};

// ===== MIDDLEWARE =====
app.use(compression({
    filter: (req, res) => {
        if (req.path === '/video-proxy') return false;
        if (req.headers.accept && (req.headers.accept.includes('video') || req.headers.accept.includes('audio'))) return false;
        return compression.filter(req, res);
    },
    level: 6
}));

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:", "http:"],
            mediaSrc: ["'self'", "blob:", "data:", "https:", "http:", "*"],
            connectSrc: ["'self'", "https:", "http:", "*"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));

const videoProxyLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, 
    max: 500,
    skip: (req) => req.headers.range
});

// ===== ESTADO GLOBAL =====
let LANGUAGE_DATA = {};         // Caché de datos por idioma
let AVAILABLE_LANGUAGES = [];   // Idiomas disponibles (con archivo existente)

// ===== LOGGING =====
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = { 'INFO': 'ℹ️', 'OK': '✅', 'WARN': '⚠️', 'ERROR': '❌', 'LANG': '🌐' }[level] || '•';
    console.log(`[${timestamp}] ${prefix} ${message}`, data ? JSON.stringify(data) : '');
}

// ===== CARGAR ARCHIVO DE IDIOMA =====
function loadLanguageFile(langCode) {
    const langConfig = config.LANGUAGES[langCode];
    if (!langConfig) {
        log('WARN', `Idioma no configurado: ${langCode}`);
        return null;
    }

    try {
        const jsonPath = path.join(__dirname, langConfig.file);
        
        if (!fs.existsSync(jsonPath)) {
            log('WARN', `Archivo no existe: ${langConfig.file}`);
            return null;
        }
        
        const rawData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        
        if (!Array.isArray(rawData)) {
            log('WARN', `Formato inválido: ${langConfig.file}`);
            return null;
        }

        // Procesar datos
        const seriesIndex = {};
        
        rawData.forEach(item => {
            const name = item.series || 'Sin nombre';
            const season = String(item.season || '1');
            
            if (!seriesIndex[name]) {
                seriesIndex[name] = { 
                    name, 
                    poster: item["logo serie"] || '', 
                    seasons: {}, 
                    count: 0 
                };
            }
            
            if (!seriesIndex[name].seasons[season]) {
                seriesIndex[name].seasons[season] = [];
            }
            
            seriesIndex[name].seasons[season].push({ 
                ep: item.ep || 1, 
                title: item.title || 'Episodio ' + (item.ep || 1), 
                url: item.url || ''
            });
            seriesIndex[name].count++;
        });

        // Ordenar episodios
        Object.values(seriesIndex).forEach(s => 
            Object.keys(s.seasons).forEach(k => 
                s.seasons[k].sort((a, b) => a.ep - b.ep)
            )
        );
        
        // Crear lista de series
        const seriesList = Object.values(seriesIndex)
            .map(s => ({ 
                name: s.name, 
                poster: s.poster, 
                seasons: Object.keys(s.seasons).length, 
                count: s.count 
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        log('OK', `Cargado [${langCode}]: ${langConfig.file}`, { 
            series: seriesList.length, 
            episodios: rawData.length 
        });
        
        return {
            code: langCode,
            name: langConfig.name,
            flag: langConfig.flag,
            seriesIndex,
            seriesList,
            totalEpisodes: rawData.length
        };
        
    } catch (e) { 
        log('ERROR', `Error cargando ${langConfig.file}: ${e.message}`);
        return null;
    }
}

// ===== OBTENER DATOS DE UN IDIOMA =====
function getLanguageData(langCode) {
    // Si no está en caché, cargar
    if (!LANGUAGE_DATA[langCode]) {
        const data = loadLanguageFile(langCode);
        if (data) {
            LANGUAGE_DATA[langCode] = data;
        }
    }
    return LANGUAGE_DATA[langCode] || null;
}

// ===== DETECTAR IDIOMAS DISPONIBLES =====
function detectAvailableLanguages() {
    AVAILABLE_LANGUAGES = [];
    
    for (const [code, langConfig] of Object.entries(config.LANGUAGES)) {
        const jsonPath = path.join(__dirname, langConfig.file);
        if (fs.existsSync(jsonPath)) {
            AVAILABLE_LANGUAGES.push({
                code,
                name: langConfig.name,
                flag: langConfig.flag,
                file: langConfig.file
            });
            log('LANG', `Idioma disponible: ${langConfig.flag} ${langConfig.name} (${code})`);
        }
    }
    
    log('INFO', `Total idiomas disponibles: ${AVAILABLE_LANGUAGES.length}`);
    return AVAILABLE_LANGUAGES;
}

// ===== INICIALIZACIÓN =====
function initialize() {
    log('INFO', '════════════════════════════════════════');
    log('INFO', 'Iniciando Stream+ Multilenguaje...');
    
    detectAvailableLanguages();
    
    // Pre-cargar idioma por defecto
    if (AVAILABLE_LANGUAGES.length > 0) {
        const defaultLang = AVAILABLE_LANGUAGES.find(l => l.code === config.DEFAULT_LANGUAGE) || AVAILABLE_LANGUAGES[0];
        getLanguageData(defaultLang.code);
        log('OK', `Idioma por defecto: ${defaultLang.flag} ${defaultLang.name}`);
    } else {
        log('ERROR', 'No hay archivos de idioma disponibles');
    }
    
    log('INFO', '════════════════════════════════════════');
}

initialize();

// ===== CORS =====
app.use((req, res, next) => { 
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next(); 
});

// ===== API: IDIOMAS DISPONIBLES =====
app.get('/api/languages', (req, res) => {
    res.json({ 
        available: AVAILABLE_LANGUAGES,
        default: config.DEFAULT_LANGUAGE
    });
});

// ===== API: ESTADÍSTICAS POR IDIOMA =====
app.get('/api/stats', (req, res) => {
    const lang = req.query.lang || config.DEFAULT_LANGUAGE;
    const data = getLanguageData(lang);
    
    if (!data) {
        return res.status(404).json({ error: 'Idioma no disponible' });
    }
    
    res.json({ 
        language: {
            code: data.code,
            name: data.name,
            flag: data.flag
        },
        series: data.seriesList.length, 
        episodes: data.totalEpisodes
    });
});

// ===== API: LISTA DE SERIES POR IDIOMA =====
app.get('/api/series', (req, res) => {
    const lang = req.query.lang || config.DEFAULT_LANGUAGE;
    const data = getLanguageData(lang);
    
    if (!data) {
        return res.status(404).json({ error: 'Idioma no disponible' });
    }
    
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 250;
    const search = (req.query.q || '').toLowerCase();
    const random = req.query.random === 'true';
    
    let list = [...data.seriesList];
    
    if (search) {
        list = list.filter(s => s.name.toLowerCase().includes(search));
    }
    
    if (random) {
        for (let i = list.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [list[i], list[j]] = [list[j], list[i]];
        }
    }
    
    const start = page * limit;
    res.json({ 
        language: data.code,
        total: list.length, 
        page, 
        hasMore: start + limit < list.length, 
        data: list.slice(start, start + limit) 
    });
});

// ===== API: DETALLE DE SERIE POR IDIOMA =====
app.get('/api/series/:name', (req, res) => {
    const lang = req.query.lang || config.DEFAULT_LANGUAGE;
    const data = getLanguageData(lang);
    
    if (!data) {
        return res.status(404).json({ error: 'Idioma no disponible' });
    }
    
    const series = data.seriesIndex[decodeURIComponent(req.params.name)];
    
    if (!series) {
        return res.status(404).json({ error: 'Serie no encontrada' });
    }
    
    res.json({ 
        language: data.code,
        data: series 
    });
});

// ===== VIDEO PROXY =====
app.get('/video-proxy', videoProxyLimiter, (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'URL requerida' });

    let parsed;
    try {
        parsed = new URL(decodeURIComponent(url));
    } catch (e) {
        return res.status(400).json({ error: 'URL inválida' });
    }

    const client = parsed.protocol === 'https:' ? https : http;

    const opts = { 
        hostname: parsed.hostname, 
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), 
        path: parsed.pathname + parsed.search, 
        method: 'GET',
        timeout: 30000,
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
            'Connection': 'keep-alive',
            'Referer': parsed.origin + '/'
        } 
    };

    if (req.headers.range) {
        opts.headers['Range'] = req.headers.range;
    }

    const proxyReq = client.request(opts, proxyRes => {
        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            proxyRes.destroy();
            return res.redirect('/video-proxy?url=' + encodeURIComponent(proxyRes.headers.location));
        }

        if (proxyRes.statusCode >= 400) {
            proxyRes.destroy();
            return res.status(proxyRes.statusCode).json({ error: 'Error del servidor origen' });
        }

        const headers = {
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600'
        };

        if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
        if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });

        proxyRes.on('error', () => {
            if (!res.headersSent) res.status(502).json({ error: 'Stream error' });
            else res.end();
        });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) res.status(504).json({ error: 'Timeout' });
    });

    proxyReq.on('error', () => {
        if (!res.headersSent) res.status(502).json({ error: 'Connection error' });
    });

    req.on('close', () => proxyReq.destroy());
    proxyReq.end();
});

// ===== HTML =====
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Stream+</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;user-select:none;-webkit-tap-highlight-color:transparent}
:root{--bg:#0a0a0a;--surface:#141414;--card:#1c1c1c;--border:#2a2a2a;--text:#e0e0e0;--text2:#888;--accent:#e50914}
html,body{background:var(--bg);color:var(--text);font-family:-apple-system,system-ui,sans-serif;height:100%;overflow:hidden}
#app{height:100%;display:flex;flex-direction:column}

/* Header */
.hdr{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.logo{color:var(--accent);font-weight:800;font-size:22px;letter-spacing:-1px}
.srch{flex:1;min-width:100px;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:10px 14px;border-radius:8px;font-size:14px;outline:none}
.srch:focus{border-color:var(--accent)}
.btn{background:var(--card);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:8px;font-size:14px;cursor:pointer}
.btn:hover{background:var(--border)}

/* Selector de idioma */
.lang-btn{display:flex;align-items:center;gap:6px;padding:8px 12px;background:var(--card);border:1px solid var(--border);border-radius:8px;cursor:pointer;font-size:14px}
.lang-btn:hover{border-color:var(--accent)}
.lang-flag{font-size:18px}
.lang-name{color:var(--text);font-weight:500}
.lang-arrow{color:var(--text2);font-size:10px}

/* Modal de idiomas */
.lang-modal{position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:500;display:none;align-items:center;justify-content:center}
.lang-modal.open{display:flex}
.lang-box{background:var(--surface);border-radius:16px;padding:24px;max-width:400px;width:90%}
.lang-title{font-size:18px;font-weight:700;margin-bottom:20px;text-align:center}
.lang-list{display:flex;flex-direction:column;gap:8px}
.lang-item{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--card);border:2px solid transparent;border-radius:10px;cursor:pointer;transition:all .2s}
.lang-item:hover{border-color:var(--border);background:var(--bg)}
.lang-item.active{border-color:var(--accent);background:rgba(229,9,20,.1)}
.lang-item-flag{font-size:28px}
.lang-item-info{flex:1}
.lang-item-name{font-size:15px;font-weight:600}
.lang-item-count{font-size:12px;color:var(--text2);margin-top:2px}
.lang-item-check{color:var(--accent);font-size:18px;opacity:0}
.lang-item.active .lang-item-check{opacity:1}
.lang-close{margin-top:20px;width:100%;padding:14px;background:var(--card);border:1px solid var(--border);border-radius:10px;color:var(--text);font-size:14px;cursor:pointer}

/* Stats */
.stats{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text2)}

/* Main grid */
.main{flex:1;overflow-y:auto;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
@media(min-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
@media(min-width:900px){.grid{grid-template-columns:repeat(auto-fill,minmax(170px,1fr))}}

.card{aspect-ratio:2/3;background:var(--card);border-radius:8px;overflow:hidden;cursor:pointer;position:relative}
.card:hover{transform:scale(1.02);transition:transform .2s}
.card img{width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .3s}
.card img.ok{opacity:1}
.card-t{position:absolute;bottom:0;left:0;right:0;padding:40px 10px 10px;background:linear-gradient(transparent,rgba(0,0,0,.95));font-size:12px;font-weight:600}

/* Panel detalle */
.panel{position:fixed;inset:0;background:var(--bg);z-index:100;display:none;flex-direction:column}
.panel.open{display:flex}
.panel-hdr{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.back{width:40px;height:40px;background:var(--card);border:none;border-radius:10px;color:var(--text);font-size:16px;cursor:pointer}
.panel-title{flex:1;font-size:17px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.tabs{display:flex;gap:8px;padding:12px 16px;background:var(--surface);overflow-x:auto}
.tab{padding:10px 20px;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text2);font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}

.list{flex:1;overflow-y:auto;padding:12px}
.ep{display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--card);border-radius:10px;margin-bottom:8px;cursor:pointer}
.ep:hover{background:var(--border)}
.ep-n{width:38px;height:38px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0}
.ep-info{flex:1;min-width:0}
.ep-t{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ep-m{font-size:12px;color:var(--text2);margin-top:2px}

/* Player */
.player{position:fixed;inset:0;background:#000;z-index:200;display:none}
.player.open{display:block}
video{width:100%;height:100%;object-fit:contain}

.p-ui{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;opacity:1;transition:opacity .2s}
.p-ui.hide{opacity:0;pointer-events:none}
.p-top{padding:20px;background:linear-gradient(rgba(0,0,0,.8),transparent)}
.p-title{font-size:16px;font-weight:700}
.p-sub{font-size:12px;color:var(--text2);margin-top:4px}
.p-bottom{padding:20px;background:linear-gradient(transparent,rgba(0,0,0,.8))}
.p-bar{height:5px;background:rgba(255,255,255,.2);border-radius:3px;margin-bottom:20px;cursor:pointer;position:relative}
.p-bar-fill{height:100%;background:var(--accent);border-radius:3px;width:0;transition:width .1s}
.p-time{display:flex;justify-content:space-between;font-size:12px;color:var(--text2);margin-bottom:16px}
.p-ctrl{display:flex;justify-content:center;align-items:center;gap:20px}
.p-btn{width:50px;height:50px;background:rgba(255,255,255,.1);border:none;border-radius:50%;color:#fff;font-size:18px;cursor:pointer}
.p-btn:hover{background:rgba(255,255,255,.2)}
.p-btn.main{width:64px;height:64px;background:var(--accent);font-size:24px}

.p-load,.p-err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;display:none}
.p-load.show,.p-err.show{display:block}
.p-spin{width:50px;height:50px;border:4px solid rgba(255,255,255,.1);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 16px}
.p-load-txt{font-size:14px;color:var(--text2)}
.p-err-icon{font-size:48px;margin-bottom:16px}
.p-err-t{font-size:16px;font-weight:600;margin-bottom:8px}
.p-err-sub{font-size:13px;color:var(--text2);margin-bottom:20px}
.p-err-btns{display:flex;gap:10px;justify-content:center}
.p-err-btn{padding:12px 24px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
.p-err-btn.sec{background:transparent;border:1px solid var(--border)}

.msg{text-align:center;padding:60px 20px;color:var(--text2)}
.msg-loading::after{content:'';display:block;width:30px;height:30px;margin:20px auto 0;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}

@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="app">
    <!-- Header -->
    <div class="hdr">
        <div class="logo">STREAM+</div>
        <input class="srch" id="srch" placeholder="Buscar series...">
        <button class="btn" id="randomBtn">🎲</button>
        <div class="lang-btn" id="langBtn">
            <span class="lang-flag" id="langFlag">🇪🇸</span>
            <span class="lang-name" id="langName">Español</span>
            <span class="lang-arrow">▼</span>
        </div>
        <div class="stats" id="stats">--</div>
    </div>
    
    <!-- Main content -->
    <div class="main" id="main">
        <div class="grid" id="grid"><div class="msg msg-loading">Cargando...</div></div>
    </div>

    <!-- Language Modal -->
    <div class="lang-modal" id="langModal">
        <div class="lang-box">
            <div class="lang-title">🌐 Seleccionar idioma</div>
            <div class="lang-list" id="langList"></div>
            <button class="lang-close" id="langClose">Cerrar</button>
        </div>
    </div>

    <!-- Detail Panel -->
    <div class="panel" id="detail">
        <div class="panel-hdr">
            <button class="back" id="detBack">←</button>
            <div class="panel-title" id="detTitle"></div>
        </div>
        <div class="tabs" id="tabs"></div>
        <div class="list" id="eps"></div>
    </div>

    <!-- Player -->
    <div class="player" id="player">
        <video id="vid" playsinline></video>
        <div class="p-load" id="pLoad">
            <div class="p-spin"></div>
            <div class="p-load-txt" id="pLoadTxt">Cargando video...</div>
        </div>
        <div class="p-err" id="pErr">
            <div class="p-err-icon">⚠️</div>
            <div class="p-err-t">Error de reproducción</div>
            <div class="p-err-sub" id="pErrSub">No se pudo cargar el video</div>
            <div class="p-err-btns">
                <button class="p-err-btn" id="pRetry">Reintentar</button>
                <button class="p-err-btn sec" id="pClose">Cerrar</button>
            </div>
        </div>
        <div class="p-ui" id="pUi">
            <div class="p-top">
                <div class="p-title" id="pTitle">--</div>
                <div class="p-sub" id="pSub">--</div>
            </div>
            <div class="p-bottom">
                <div class="p-time">
                    <span id="pCur">0:00</span>
                    <span id="pDur">0:00</span>
                </div>
                <div class="p-bar" id="pBar"><div class="p-bar-fill" id="pFill"></div></div>
                <div class="p-ctrl">
                    <button class="p-btn" id="pPrev">⏮</button>
                    <button class="p-btn" id="pRw">-10</button>
                    <button class="p-btn main" id="pPp">▶</button>
                    <button class="p-btn" id="pFw">+10</button>
                    <button class="p-btn" id="pNext">⏭</button>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
(function(){
const $=id=>document.getElementById(id);

// ===== ESTADO =====
const state = {
    lang: localStorage.getItem('lang') || 'es',
    languages: [],
    series: null,
    seriesName: null,
    season: null,
    epIdx: 0,
    ep: null,
    page: 0,
    hasMore: true,
    loading: false
};

// ===== ELEMENTOS =====
const el = {
    grid: $('grid'),
    main: $('main'),
    srch: $('srch'),
    randomBtn: $('randomBtn'),
    stats: $('stats'),
    langBtn: $('langBtn'),
    langFlag: $('langFlag'),
    langName: $('langName'),
    langModal: $('langModal'),
    langList: $('langList'),
    langClose: $('langClose'),
    detail: $('detail'),
    detBack: $('detBack'),
    detTitle: $('detTitle'),
    tabs: $('tabs'),
    eps: $('eps'),
    player: $('player'),
    vid: $('vid'),
    pUi: $('pUi'),
    pTitle: $('pTitle'),
    pSub: $('pSub'),
    pLoad: $('pLoad'),
    pLoadTxt: $('pLoadTxt'),
    pErr: $('pErr'),
    pErrSub: $('pErrSub'),
    pRetry: $('pRetry'),
    pClose: $('pClose'),
    pBar: $('pBar'),
    pFill: $('pFill'),
    pCur: $('pCur'),
    pDur: $('pDur'),
    pPrev: $('pPrev'),
    pRw: $('pRw'),
    pPp: $('pPp'),
    pFw: $('pFw'),
    pNext: $('pNext')
};

let hideT;

// ===== INICIALIZACIÓN =====
async function init() {
    await loadLanguages();
    loadStats();
    loadSeries(false, true);
    setupEvents();
}

// ===== CARGAR IDIOMAS DISPONIBLES =====
async function loadLanguages() {
    try {
        const res = await fetch('/api/languages');
        const data = await res.json();
        state.languages = data.available;
        
        // Si el idioma guardado no está disponible, usar el por defecto
        if (!state.languages.find(l => l.code === state.lang)) {
            state.lang = data.default;
        }
        
        updateLangDisplay();
        renderLangList();
    } catch (e) {
        console.error('Error cargando idiomas:', e);
    }
}

// ===== ACTUALIZAR DISPLAY DE IDIOMA =====
function updateLangDisplay() {
    const lang = state.languages.find(l => l.code === state.lang);
    if (lang) {
        el.langFlag.textContent = lang.flag;
        el.langName.textContent = lang.name;
    }
}

// ===== RENDERIZAR LISTA DE IDIOMAS =====
function renderLangList() {
    el.langList.innerHTML = '';
    
    state.languages.forEach(lang => {
        const item = document.createElement('div');
        item.className = 'lang-item' + (lang.code === state.lang ? ' active' : '');
        item.innerHTML = \`
            <span class="lang-item-flag">\${lang.flag}</span>
            <div class="lang-item-info">
                <div class="lang-item-name">\${lang.name}</div>
                <div class="lang-item-count">Cargando...</div>
            </div>
            <span class="lang-item-check">✓</span>
        \`;
        
        // Cargar stats de este idioma
        fetch('/api/stats?lang=' + lang.code)
            .then(r => r.json())
            .then(d => {
                item.querySelector('.lang-item-count').textContent = d.series + ' series • ' + d.episodes + ' episodios';
            })
            .catch(() => {
                item.querySelector('.lang-item-count').textContent = 'Error';
            });
        
        item.onclick = () => selectLanguage(lang.code);
        el.langList.appendChild(item);
    });
}

// ===== SELECCIONAR IDIOMA =====
function selectLanguage(code) {
    if (code === state.lang) {
        closeLangModal();
        return;
    }
    
    state.lang = code;
    localStorage.setItem('lang', code);
    updateLangDisplay();
    
    // Marcar como activo en la lista
    el.langList.querySelectorAll('.lang-item').forEach(item => {
        const itemLang = state.languages.find(l => l.name === item.querySelector('.lang-item-name').textContent);
        item.classList.toggle('active', itemLang && itemLang.code === code);
    });
    
    // Recargar contenido
    state.page = 0;
    state.hasMore = true;
    loadStats();
    loadSeries(false, false);
    
    closeLangModal();
}

// ===== MODAL DE IDIOMAS =====
function openLangModal() {
    el.langModal.classList.add('open');
    renderLangList(); // Actualizar stats
}

function closeLangModal() {
    el.langModal.classList.remove('open');
}

// ===== CARGAR ESTADÍSTICAS =====
async function loadStats() {
    try {
        const res = await fetch('/api/stats?lang=' + state.lang);
        const data = await res.json();
        el.stats.textContent = data.series + ' series';
    } catch (e) {
        el.stats.textContent = '--';
    }
}

// ===== CARGAR SERIES =====
async function loadSeries(append, random) {
    if (state.loading) return;
    state.loading = true;
    
    if (!append) {
        el.grid.innerHTML = '<div class="msg msg-loading">Cargando...</div>';
        state.page = 0;
    }
    
    try {
        let url = '/api/series?lang=' + state.lang + '&page=' + state.page + '&limit=50';
        if (el.srch.value.trim()) url += '&q=' + encodeURIComponent(el.srch.value);
        if (random) url += '&random=true';
        
        const res = await fetch(url);
        const data = await res.json();
        
        if (!append) el.grid.innerHTML = '';
        
        if (!data.data.length && !append) {
            el.grid.innerHTML = '<div class="msg">No se encontraron series</div>';
            return;
        }
        
        data.data.forEach(s => {
            const card = document.createElement('div');
            card.className = 'card';
            card.innerHTML = \`<img data-src="\${esc(s.poster)}"><div class="card-t">\${esc(s.name)}</div>\`;
            const img = card.querySelector('img');
            obs.observe(img);
            card.onclick = () => openDetail(s.name);
            el.grid.appendChild(card);
        });
        
        state.page++;
        state.hasMore = data.hasMore;
        
    } catch (e) {
        if (!append) el.grid.innerHTML = '<div class="msg">Error al cargar</div>';
    } finally {
        state.loading = false;
    }
}

// Lazy loading de imágenes
const obs = new IntersectionObserver(entries => {
    entries.forEach(e => {
        if (e.isIntersecting) {
            const img = e.target;
            if (img.dataset.src) {
                img.src = img.dataset.src;
                img.onload = () => img.classList.add('ok');
                img.onerror = () => img.style.display = 'none';
            }
            obs.unobserve(img);
        }
    });
}, { rootMargin: '100px' });

// ===== DETALLE DE SERIE =====
async function openDetail(name) {
    state.seriesName = name;
    el.detTitle.textContent = name;
    el.detail.classList.add('open');
    el.tabs.innerHTML = '<div class="msg msg-loading"></div>';
    el.eps.innerHTML = '';
    
    try {
        const res = await fetch('/api/series/' + encodeURIComponent(name) + '?lang=' + state.lang);
        const data = await res.json();
        
        state.series = data.data;
        const seasons = Object.keys(state.series.seasons).sort((a, b) => a - b);
        state.season = seasons[0];
        
        // Renderizar tabs de temporadas
        el.tabs.innerHTML = '';
        seasons.forEach(s => {
            const tab = document.createElement('button');
            tab.className = 'tab' + (s === state.season ? ' on' : '');
            tab.textContent = 'Temporada ' + s;
            tab.onclick = () => {
                state.season = s;
                el.tabs.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.textContent === 'Temporada ' + s));
                renderEpisodes();
            };
            el.tabs.appendChild(tab);
        });
        
        renderEpisodes();
        
    } catch (e) {
        el.tabs.innerHTML = '<div class="msg">Error al cargar</div>';
    }
}

function renderEpisodes() {
    const eps = state.series?.seasons[state.season] || [];
    el.eps.innerHTML = '';
    
    if (!eps.length) {
        el.eps.innerHTML = '<div class="msg">Sin episodios</div>';
        return;
    }
    
    eps.forEach((ep, i) => {
        const div = document.createElement('div');
        div.className = 'ep';
        div.innerHTML = \`
            <div class="ep-n">\${ep.ep}</div>
            <div class="ep-info">
                <div class="ep-t">\${esc(ep.title)}</div>
                <div class="ep-m">Temporada \${state.season}</div>
            </div>
        \`;
        div.onclick = () => {
            state.epIdx = i;
            state.ep = ep;
            openPlayer(ep);
        };
        el.eps.appendChild(div);
    });
}

function closeDetail() {
    el.detail.classList.remove('open');
}

// ===== PLAYER =====
function openPlayer(ep) {
    state.ep = ep;
    el.player.classList.add('open');
    el.pErr.classList.remove('show');
    playVideo(ep.url);
}

function playVideo(url) {
    el.pLoad.classList.add('show');
    el.pLoadTxt.textContent = 'Conectando...';
    el.pTitle.textContent = state.ep.title;
    el.pSub.textContent = state.seriesName + ' • Temporada ' + state.season;
    
    let src = url;
    if (!url.startsWith('https://')) {
        src = '/video-proxy?url=' + encodeURIComponent(url);
    }
    
    el.vid.src = src;
    el.vid.play().catch(() => {});
}

function closePlayer() {
    el.vid.pause();
    el.vid.src = '';
    el.player.classList.remove('open');
}

// Video events
el.vid.onloadstart = () => { el.pLoad.classList.add('show'); el.pLoadTxt.textContent = 'Cargando...'; };
el.vid.oncanplay = () => { el.pLoad.classList.remove('show'); };
el.vid.onwaiting = () => { el.pLoad.classList.add('show'); el.pLoadTxt.textContent = 'Buffering...'; };
el.vid.onplaying = () => { el.pLoad.classList.remove('show'); el.pPp.textContent = '⏸'; };
el.vid.onpause = () => { el.pPp.textContent = '▶'; };
el.vid.ontimeupdate = () => {
    if (el.vid.duration) {
        el.pFill.style.width = (el.vid.currentTime / el.vid.duration * 100) + '%';
        el.pCur.textContent = fmt(el.vid.currentTime);
    }
};
el.vid.ondurationchange = () => { el.pDur.textContent = fmt(el.vid.duration); };
el.vid.onerror = () => {
    el.pLoad.classList.remove('show');
    el.pErr.classList.add('show');
    const err = el.vid.error;
    el.pErrSub.textContent = err ? ['', 'Carga abortada', 'Error de red', 'Error de decodificación', 'Formato no soportado'][err.code] || 'Error desconocido' : 'Error desconocido';
};

// Player controls
el.pPp.onclick = () => { if (el.vid.paused) el.vid.play(); else el.vid.pause(); showUI(); };
el.pRw.onclick = () => { el.vid.currentTime = Math.max(0, el.vid.currentTime - 10); showUI(); };
el.pFw.onclick = () => { el.vid.currentTime += 10; showUI(); };
el.pPrev.onclick = () => {
    if (state.epIdx > 0) {
        state.epIdx--;
        state.ep = state.series.seasons[state.season][state.epIdx];
        playVideo(state.ep.url);
    }
};
el.pNext.onclick = () => {
    const eps = state.series.seasons[state.season];
    if (state.epIdx < eps.length - 1) {
        state.epIdx++;
        state.ep = eps[state.epIdx];
        playVideo(state.ep.url);
    }
};
el.pBar.onclick = e => {
    const rect = el.pBar.getBoundingClientRect();
    el.vid.currentTime = (e.clientX - rect.left) / rect.width * el.vid.duration;
};
el.pRetry.onclick = () => { el.pErr.classList.remove('show'); playVideo(state.ep.url); };
el.pClose.onclick = closePlayer;
el.player.onclick = e => { if (e.target === el.vid) { if (el.vid.paused) el.vid.play(); else el.vid.pause(); showUI(); } };
el.player.onmousemove = showUI;
el.player.ontouchmove = showUI;

function showUI() {
    el.pUi.classList.remove('hide');
    clearTimeout(hideT);
    hideT = setTimeout(() => { if (!el.vid.paused) el.pUi.classList.add('hide'); }, 3000);
}

// ===== EVENTOS =====
function setupEvents() {
    // Búsqueda
    let searchT;
    el.srch.oninput = () => {
        clearTimeout(searchT);
        searchT = setTimeout(() => loadSeries(false, !el.srch.value.trim()), 300);
    };
    
    // Random
    el.randomBtn.onclick = () => loadSeries(false, true);
    
    // Scroll infinito
    el.main.onscroll = () => {
        if (!state.loading && state.hasMore) {
            const { scrollTop, scrollHeight, clientHeight } = el.main;
            if (scrollTop + clientHeight >= scrollHeight - 200) loadSeries(true, false);
        }
    };
    
    // Idioma
    el.langBtn.onclick = openLangModal;
    el.langClose.onclick = closeLangModal;
    el.langModal.onclick = e => { if (e.target === el.langModal) closeLangModal(); };
    
    // Navegación
    el.detBack.onclick = closeDetail;
    
    // Teclado
    document.onkeydown = e => {
        if (el.player.classList.contains('open')) {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (el.vid.paused) el.vid.play(); else el.vid.pause(); showUI(); }
            if (e.key === 'ArrowLeft') { el.vid.currentTime -= 10; showUI(); }
            if (e.key === 'ArrowRight') { el.vid.currentTime += 10; showUI(); }
            if (e.key === 'Escape') closePlayer();
        } else if (el.detail.classList.contains('open')) {
            if (e.key === 'Escape') closeDetail();
        }
    };
}

// ===== UTILIDADES =====
function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return m + ':' + String(ss).padStart(2, '0');
}

function esc(s) {
    return s ? String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) : '';
}

// ===== INICIAR =====
init();

})();
</script>
</body>
</html>`;

app.get('/', (req, res) => { 
    res.setHeader('Content-Type', 'text/html'); 
    res.send(HTML); 
});

app.get('/health', (req, res) => res.json({ 
    ok: true, 
    languages: AVAILABLE_LANGUAGES.length
}));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
    log('INFO', `Stream+ Multilenguaje corriendo en puerto ${PORT}`);
    log('INFO', `Idiomas disponibles: ${AVAILABLE_LANGUAGES.map(l => l.flag).join(' ')}`);
});
