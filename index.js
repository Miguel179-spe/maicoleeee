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

const config = { DATA_FILE: process.env.DATA_FILE || 'data.json' };

// ===== OPTIMIZACIÓN 1: Compresión SOLO para contenido que lo necesita =====
app.use(compression({
    filter: (req, res) => {
        // NO comprimir streams de video/audio
        if (req.path === '/video-proxy') return false;
        if (req.headers.accept && (
            req.headers.accept.includes('video') || 
            req.headers.accept.includes('audio')
        )) return false;
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
    max: 500, // Aumentado para streaming
    skip: (req) => req.headers.range // No limitar requests de range
});

let SERIES_LIST = [];
let SERIES_INDEX = {};
let TOTAL_EPISODES = 0;

function loadData() {
    try {
        const jsonPath = path.join(__dirname, config.DATA_FILE);
        if (!fs.existsSync(jsonPath)) return;
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!Array.isArray(data)) return;

        TOTAL_EPISODES = data.length;
        const map = {};
        data.forEach(item => {
            const name = item.series || 'Sin nombre';
            const season = String(item.season || '1');
            if (!map[name]) map[name] = { name, poster: item["logo serie"] || '', seasons: {}, count: 0 };
            if (!map[name].seasons[season]) map[name].seasons[season] = [];
            map[name].seasons[season].push({ ep: item.ep || 1, title: item.title || 'Episodio ' + (item.ep || 1), url: item.url || '' });
            map[name].count++;
        });

        Object.values(map).forEach(s => Object.keys(s.seasons).forEach(k => s.seasons[k].sort((a, b) => a.ep - b.ep)));
        SERIES_INDEX = map;
        SERIES_LIST = Object.values(map).map(s => ({ name: s.name, poster: s.poster, seasons: Object.keys(s.seasons).length, count: s.count })).sort((a, b) => a.name.localeCompare(b.name));
        console.log('[OK] ' + SERIES_LIST.length + ' series, ' + TOTAL_EPISODES + ' episodios');
    } catch (e) { console.error('[ERROR]', e.message); }
}

loadData();

// ===== OPTIMIZACIÓN 2: Headers CORS mejorados para streaming =====
app.use((req, res, next) => { 
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next(); 
});

app.get('/api/stats', (req, res) => res.json({ series: SERIES_LIST.length, episodes: TOTAL_EPISODES }));

app.get('/api/series', (req, res) => {
    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 250;
    const search = (req.query.q || '').toLowerCase();
    const random = req.query.random === 'true';
    let list = [...SERIES_LIST];
    if (search) list = list.filter(s => s.name.toLowerCase().includes(search));
    if (random) for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    const start = page * limit;
    res.json({ total: list.length, page, hasMore: start + limit < list.length, data: list.slice(start, start + limit) });
});

app.get('/api/series/:name', (req, res) => {
    const series = SERIES_INDEX[decodeURIComponent(req.params.name)];
    if (!series) return res.status(404).json({ error: 'No encontrada' });
    res.json({ data: series });
});

// ===== OPTIMIZACIÓN 3: Proxy de Video COMPLETAMENTE REESCRITO =====
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
        timeout: 30000, // 30 segundos timeout
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity', // Sin compresión para video
            'Connection': 'keep-alive',
            'Referer': parsed.origin + '/'
        } 
    };

    // ===== CRÍTICO: Pasar Range header para streaming =====
    if (req.headers.range) {
        opts.headers['Range'] = req.headers.range;
    }

    const proxyReq = client.request(opts, proxyRes => {
        // Manejar redirects
        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
            // Limpiar listeners para evitar memory leak
            proxyRes.destroy();
            return res.redirect('/video-proxy?url=' + encodeURIComponent(proxyRes.headers.location));
        }

        // Headers de respuesta optimizados para streaming
        const headers = {
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff'
        };

        // Headers críticos para Range requests
        if (proxyRes.headers['content-length']) {
            headers['Content-Length'] = proxyRes.headers['content-length'];
        }
        if (proxyRes.headers['content-range']) {
            headers['Content-Range'] = proxyRes.headers['content-range'];
        }

        // Status code correcto (206 para partial content)
        const statusCode = proxyRes.statusCode;
        res.writeHead(statusCode, headers);

        // ===== CRÍTICO: Streaming directo sin buffering completo =====
        proxyRes.pipe(res, { end: true });

        // Manejo de errores en el stream
        proxyRes.on('error', (err) => {
            console.error('[PROXY STREAM ERROR]', err.message);
            if (!res.headersSent) {
                res.status(502).json({ error: 'Stream error' });
            } else {
                res.end();
            }
        });
    });

    // Timeout
    proxyReq.on('timeout', () => {
        console.error('[PROXY TIMEOUT]');
        proxyReq.destroy();
        if (!res.headersSent) {
            res.status(504).json({ error: 'Timeout' });
        }
    });

    // Error de conexión
    proxyReq.on('error', (err) => {
        console.error('[PROXY ERROR]', err.message);
        if (!res.headersSent) {
            res.status(502).json({ error: 'Connection error' });
        }
    });

    // Cuando el cliente cierra la conexión
    req.on('close', () => {
        proxyReq.destroy();
    });

    proxyReq.end();
});

// ===== OPTIMIZACIÓN 4: HTML con Player Mejorado =====
const HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Stream+</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;user-select:none;-webkit-tap-highlight-color:transparent}
:root{--bg:#0a0a0a;--surface:#161616;--card:#1a1a1a;--border:#2a2a2a;--text:#e0e0e0;--text2:#707070;--accent:#c00;--focus:#fff}
html,body{background:var(--bg);color:var(--text);font-family:-apple-system,system-ui,sans-serif;height:100%;overflow:hidden}
#app{height:100%;display:flex;flex-direction:column}

.hdr{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.logo{color:var(--accent);font-weight:700;font-size:20px;letter-spacing:-1px}
.srch{flex:1;background:var(--bg);border:2px solid var(--border);color:var(--text);padding:10px 16px;border-radius:8px;font-size:14px;outline:none}
.srch:focus,.srch.f{border-color:var(--focus)}
.btn{background:var(--card);border:2px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.btn.f{border-color:var(--focus)}
.stats{color:var(--text2);font-size:12px}

.main{flex:1;overflow-y:auto;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
@media(min-width:900px){.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}}
@media(min-width:1400px){.grid{grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px}}

.card{position:relative;aspect-ratio:2/3;background:var(--card);border-radius:6px;overflow:hidden;border:2px solid transparent;cursor:pointer}
.card.f{border-color:var(--focus)}
.card img{width:100%;height:100%;object-fit:cover;opacity:0}
.card img.ok{opacity:1}
.card img.err{opacity:.2}
.card-t{position:absolute;bottom:0;left:0;right:0;padding:30px 8px 8px;background:linear-gradient(transparent,#000);font-size:12px;font-weight:600;opacity:0}
.card.f .card-t{opacity:1}

.panel{position:fixed;inset:0;background:var(--bg);z-index:100;display:none;flex-direction:column}
.panel.open{display:flex}
.panel-hdr{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--surface);border-bottom:1px solid var(--border)}
.back{width:40px;height:40px;background:var(--card);border:2px solid transparent;border-radius:8px;color:var(--text);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.back.f{border-color:var(--focus)}
.panel-title{flex:1;font-size:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.tabs{display:flex;gap:8px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:8px 18px;background:var(--bg);border:2px solid var(--border);border-radius:6px;color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}
.tab.f{border-color:var(--focus)}

.list{flex:1;overflow-y:auto;padding:12px}
.ep{display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--card);border:2px solid transparent;border-radius:8px;margin-bottom:8px;cursor:pointer}
.ep.f{border-color:var(--focus);background:var(--surface)}
.ep-n{width:36px;height:36px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0}
.ep-t{font-size:14px;font-weight:500}
.ep-m{font-size:12px;color:var(--text2);margin-top:2px}

.player{position:fixed;inset:0;background:#000;z-index:200;display:none}
.player.open{display:block}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}

.p-ui{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;opacity:1;transition:opacity .15s}
.p-ui.hide{opacity:0;pointer-events:none}

.p-top{padding:16px 20px;background:linear-gradient(#000a,transparent)}
.p-title{font-size:15px;font-weight:600}
.p-status{font-size:12px;color:var(--text2);margin-top:4px}

.p-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:48px;font-weight:700;opacity:0;transition:opacity .15s}
.p-center.show{opacity:1}

.p-vol{position:absolute;right:30px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;opacity:0;transition:opacity .15s}
.p-vol.show{opacity:1}
.p-vol-bar{width:6px;height:100px;background:#333;border-radius:3px;position:relative}
.p-vol-fill{position:absolute;bottom:0;left:0;right:0;background:var(--accent);border-radius:3px}
.p-vol-pct{font-size:13px;font-weight:600}

.p-bottom{padding:16px 20px 20px;background:linear-gradient(transparent,#000a)}
.p-prog{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.p-time{font-size:13px;font-weight:500;min-width:50px}
.p-time:last-child{text-align:right}
.p-bar{flex:1;height:4px;background:#444;border-radius:2px;position:relative;cursor:pointer}
.p-bar.f{height:6px;box-shadow:0 0 0 2px var(--focus)}
.p-bar-fill{position:absolute;left:0;top:0;height:100%;background:var(--accent);border-radius:2px;z-index:2}
.p-bar-buf{position:absolute;left:0;top:0;height:100%;background:#666;border-radius:2px;z-index:1}
.p-bar-dot{position:absolute;top:50%;transform:translate(-50%,-50%);width:14px;height:14px;background:#fff;border-radius:50%;opacity:0;z-index:3}
.p-bar.f .p-bar-dot{opacity:1}

.p-ctrl{display:flex;justify-content:center;gap:12px}
.p-btn{width:48px;height:48px;background:transparent;border:2px solid transparent;border-radius:50%;color:#fff;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center}
.p-btn.f{border-color:var(--focus);background:#222}
.p-btn.main{width:56px;height:56px;background:#222;font-size:16px}
.p-btn.main.f{background:var(--accent);border-color:var(--accent)}

.p-next{position:absolute;bottom:120px;right:20px;background:#111;border:1px solid var(--border);border-radius:10px;padding:16px 20px;display:none;max-width:280px}
.p-next.show{display:block}
.p-next-lbl{font-size:11px;color:var(--text2);text-transform:uppercase;margin-bottom:6px}
.p-next-t{font-size:14px;font-weight:600;margin-bottom:4px}
.p-next-cd{font-size:12px;color:var(--accent);margin-bottom:12px}
.p-next-btns{display:flex;gap:8px}
.p-next-btn{padding:8px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;border:2px solid transparent}
.p-next-btn.f{border-color:var(--focus)}
.p-next-btn.pri{background:var(--accent);color:#fff}
.p-next-btn.sec{background:transparent;color:var(--text);border-color:var(--border)}

.p-err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;display:none}
.p-err.show{display:block}
.p-err-t{font-size:16px;margin-bottom:8px}
.p-err-sub{font-size:12px;color:var(--text2);margin-bottom:16px}
.p-err-btn{padding:12px 24px;background:var(--accent);border:2px solid transparent;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin:4px}
.p-err-btn.f{border-color:var(--focus)}
.p-err-btn.sec{background:transparent;border-color:var(--border)}

.p-load{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);display:none;text-align:center}
.p-load.show{display:block}
.p-load-spin{width:40px;height:40px;border:3px solid #333;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px}
.p-load-txt{font-size:12px;color:var(--text2)}

.msg{text-align:center;padding:60px 20px;color:var(--text2)}
.msg.load::after{content:'';display:block;width:24px;height:24px;margin:16px auto 0;border:2px solid #333;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}

@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="app">
    <div class="hdr">
        <div class="logo">STREAM+</div>
        <input class="srch" id="srch" placeholder="Buscar serie...">
        <button class="btn" id="mix">Aleatorio</button>
        <span class="stats" id="stats"></span>
    </div>
    <div class="main" id="main">
        <div class="grid" id="grid"><div class="msg load">Cargando</div></div>
    </div>

    <div class="panel" id="detail">
        <div class="panel-hdr">
            <button class="back" id="det-back">◀</button>
            <div class="panel-title" id="det-title"></div>
        </div>
        <div class="tabs" id="tabs"></div>
        <div class="list" id="eps"></div>
    </div>

    <div class="player" id="player">
        <video id="vid" playsinline preload="auto"></video>
        <div class="p-load" id="p-load">
            <div class="p-load-spin"></div>
            <div class="p-load-txt" id="p-load-txt">Cargando...</div>
        </div>
        <div class="p-err" id="p-err">
            <div class="p-err-t">Error de reproducción</div>
            <div class="p-err-sub" id="p-err-sub">No se pudo cargar el video</div>
            <button class="p-err-btn" id="p-retry">Reintentar</button>
            <button class="p-err-btn sec" id="p-back">Volver</button>
        </div>
        <div class="p-center" id="p-ind"></div>
        <div class="p-vol" id="p-vol">
            <div class="p-vol-pct" id="p-vol-pct">100%</div>
            <div class="p-vol-bar"><div class="p-vol-fill" id="p-vol-fill" style="height:100%"></div></div>
        </div>
        <div class="p-ui" id="p-ui">
            <div class="p-top">
                <div class="p-title" id="p-title"></div>
                <div class="p-status" id="p-status"></div>
            </div>
            <div class="p-next" id="p-next">
                <div class="p-next-lbl">Siguiente</div>
                <div class="p-next-t" id="p-next-t"></div>
                <div class="p-next-cd" id="p-next-cd"></div>
                <div class="p-next-btns">
                    <button class="p-next-btn pri" id="p-next-play">Reproducir</button>
                    <button class="p-next-btn sec" id="p-next-cancel">Cancelar</button>
                </div>
            </div>
            <div class="p-bottom">
                <div class="p-prog">
                    <span class="p-time" id="p-cur">0:00</span>
                    <div class="p-bar" id="p-bar">
                        <div class="p-bar-buf" id="p-bar-buf"></div>
                        <div class="p-bar-fill" id="p-bar-fill"></div>
                        <div class="p-bar-dot" id="p-bar-dot"></div>
                    </div>
                    <span class="p-time" id="p-dur">0:00</span>
                </div>
                <div class="p-ctrl">
                    <button class="p-btn" id="p-prev">PREV</button>
                    <button class="p-btn" id="p-rw">-10</button>
                    <button class="p-btn main" id="p-pp">PLAY</button>
                    <button class="p-btn" id="p-fw">+10</button>
                    <button class="p-btn" id="p-nxt">NEXT</button>
                </div>
            </div>
        </div>
    </div>
</div>
<script>
(function(){
const $=id=>document.getElementById(id);

const state = {
    view: 'home',
    series: null,
    season: null,
    epIdx: 0,
    page: 0,
    hasMore: true,
    loading: false,
    cols: 5,
    focused: null,
    playing: false,
    lastFocused: { home: null, detail: null },
    retryCount: 0,
    maxRetries: 3
};

let hideT, volT, indT, nextT, bufferCheckT;

const el = {
    grid: $('grid'), main: $('main'), srch: $('srch'), mix: $('mix'), stats: $('stats'),
    detail: $('detail'), detBack: $('det-back'), detTitle: $('det-title'), tabs: $('tabs'), eps: $('eps'),
    player: $('player'), vid: $('vid'), pUi: $('p-ui'), pTitle: $('p-title'), pStatus: $('p-status'),
    pLoad: $('p-load'), pLoadTxt: $('p-load-txt'), pErr: $('p-err'), pErrSub: $('p-err-sub'), pRetry: $('p-retry'), pBack: $('p-back'),
    pInd: $('p-ind'), pVol: $('p-vol'), pVolFill: $('p-vol-fill'), pVolPct: $('p-vol-pct'),
    pBar: $('p-bar'), pBarFill: $('p-bar-fill'), pBarBuf: $('p-bar-buf'), pBarDot: $('p-bar-dot'),
    pCur: $('p-cur'), pDur: $('p-dur'),
    pPrev: $('p-prev'), pRw: $('p-rw'), pPp: $('p-pp'), pFw: $('p-fw'), pNxt: $('p-nxt'),
    pNext: $('p-next'), pNextT: $('p-next-t'), pNextCd: $('p-next-cd'), pNextPlay: $('p-next-play'), pNextCancel: $('p-next-cancel')
};

// ===== HISTORY API =====
function initHistory() {
    history.replaceState({ view: 'home' }, '', '#home');
    window.addEventListener('popstate', function(e) {
        handleHistoryBack(e.state);
    });
}

function pushView(view) {
    history.pushState({ view: view }, '', '#' + view);
}

function handleHistoryBack(historyState) {
    if (!historyState) {
        history.pushState({ view: 'home' }, '', '#home');
        return;
    }

    if (state.view === 'player') {
        closePlayerInternal();
        history.pushState({ view: 'detail' }, '', '#detail');
    } else if (state.view === 'detail') {
        closeDetailInternal();
        history.pushState({ view: 'home' }, '', '#home');
    } else {
        history.pushState({ view: 'home' }, '', '#home');
    }
}

// Init
initHistory();
fetch('/api/stats').then(r => r.json()).then(d => { el.stats.textContent = d.series + ' series'; }).catch(() => {});
load(false, true);
calcCols();
window.addEventListener('resize', calcCols);
document.addEventListener('keydown', onKey, true);
setupPlayer();
setupMouse();
setTimeout(() => focusFirst(), 300);

function calcCols() {
    const c = el.grid.querySelector('.card');
    if (c) {
        const w = el.grid.offsetWidth, cw = c.offsetWidth + 10;
        state.cols = Math.max(1, Math.floor(w / cw));
    }
}

function onKey(e) {
    const k = e.key;
    const navKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '];

    if (navKeys.includes(k)) {
        e.preventDefault();
        e.stopPropagation();
    }

    if (state.view === 'player') {
        playerKey(k);
        return;
    }

    if (document.activeElement === el.srch) {
        if (k === 'ArrowDown') {
            el.srch.blur();
            focusFirst();
        }
        return;
    }

    switch (k) {
        case 'ArrowUp': move('up'); break;
        case 'ArrowDown': move('down'); break;
        case 'ArrowLeft': move('left'); break;
        case 'ArrowRight': move('right'); break;
        case 'Enter': case ' ': activate(); break;
    }
}

function getFocusable() {
    if (state.view === 'home') return [...document.querySelectorAll('#srch,#mix,.card')].filter(e => e.offsetParent);
    if (state.view === 'detail') return [...document.querySelectorAll('#det-back,.tab,.ep')].filter(e => e.offsetParent);
    return [];
}

function focus(elem) {
    if (state.focused) state.focused.classList.remove('f');
    state.focused = elem;
    if (elem) {
        elem.classList.add('f');
        elem.scrollIntoView({ block: 'nearest' });
    }
}

function focusFirst() {
    const f = getFocusable();
    if (state.view === 'home') {
        if (state.lastFocused.home && f.includes(state.lastFocused.home)) {
            focus(state.lastFocused.home);
        } else {
            const card = f.find(e => e.classList.contains('card'));
            focus(card || f[0]);
        }
    } else if (state.view === 'detail') {
        if (state.lastFocused.detail && f.includes(state.lastFocused.detail)) {
            focus(state.lastFocused.detail);
        } else {
            const ep = f.find(e => e.classList.contains('ep'));
            focus(ep || f[0]);
        }
    }
}

function saveFocus() {
    if (state.view === 'home') state.lastFocused.home = state.focused;
    else if (state.view === 'detail') state.lastFocused.detail = state.focused;
}

function move(dir) {
    const f = getFocusable(), i = f.indexOf(state.focused);
    if (i < 0) { focusFirst(); return; }

    if (state.view === 'home') {
        const cards = f.filter(e => e.classList.contains('card'));
        const ci = cards.indexOf(state.focused);
        if (ci >= 0) {
            if (dir === 'up') {
                if (ci < state.cols) focus(el.mix);
                else focus(cards[ci - state.cols]);
            }
            if (dir === 'down') {
                const ni = ci + state.cols;
                if (ni < cards.length) focus(cards[ni]);
                else if (state.hasMore) load(true, false);
            }
            if (dir === 'left' && ci > 0) focus(cards[ci - 1]);
            if (dir === 'right' && ci < cards.length - 1) focus(cards[ci + 1]);
        } else {
            if (state.focused === el.srch && dir === 'right') focus(el.mix);
            if (state.focused === el.mix && dir === 'left') focus(el.srch);
            if (dir === 'down' && cards.length) focus(cards[0]);
        }
    }

    if (state.view === 'detail') {
        const tabs = f.filter(e => e.classList.contains('tab'));
        const eps = f.filter(e => e.classList.contains('ep'));
        const ti = tabs.indexOf(state.focused);
        const ei = eps.indexOf(state.focused);

        if (state.focused === el.detBack) {
            if (dir === 'down' && tabs.length) focus(tabs[0]);
            if (dir === 'right' && tabs.length) focus(tabs[0]);
        } else if (ti >= 0) {
            if (dir === 'up') focus(el.detBack);
            if (dir === 'down' && eps.length) focus(eps[0]);
            if (dir === 'left') {
                if (ti > 0) focus(tabs[ti - 1]);
                else focus(el.detBack);
            }
            if (dir === 'right' && ti < tabs.length - 1) focus(tabs[ti + 1]);
        } else if (ei >= 0) {
            if (dir === 'up') {
                if (ei > 0) focus(eps[ei - 1]);
                else if (tabs.length) focus(tabs[0]);
            }
            if (dir === 'down' && ei < eps.length - 1) focus(eps[ei + 1]);
        }
    }
}

function activate() {
    if (!state.focused) return;
    if (state.focused === el.srch) { el.srch.focus(); return; }
    state.focused.click();
}

// ===== PLAYER OPTIMIZADO =====
function playerKey(k) {
    showUI();
    switch (k) {
        case 'ArrowLeft': seek(-10); break;
        case 'ArrowRight': seek(10); break;
        case 'ArrowUp': vol(0.1); break;
        case 'ArrowDown': vol(-0.1); break;
        case 'Enter': case ' ': togglePlay(); break;
    }
}

function togglePlay() {
    if (el.vid.paused) { 
        el.vid.play().catch(handlePlayError); 
        showInd('▶'); 
    } else { 
        el.vid.pause(); 
        showInd('⏸'); 
    }
}

function seek(s) {
    const newTime = Math.max(0, Math.min(el.vid.currentTime + s, el.vid.duration || 0));
    el.vid.currentTime = newTime;
    showInd((s > 0 ? '+' : '') + s + 's');
}

function vol(d) {
    el.vid.volume = Math.max(0, Math.min(1, el.vid.volume + d));
    updateVol();
    el.pVol.classList.add('show');
    clearTimeout(volT);
    volT = setTimeout(() => el.pVol.classList.remove('show'), 1500);
}

function updateVol() {
    const v = Math.round(el.vid.volume * 100);
    el.pVolFill.style.height = v + '%';
    el.pVolPct.textContent = v + '%';
}

function showInd(txt) {
    el.pInd.textContent = txt;
    el.pInd.classList.add('show');
    clearTimeout(indT);
    indT = setTimeout(() => el.pInd.classList.remove('show'), 500);
}

function showUI() {
    el.pUi.classList.remove('hide');
    clearTimeout(hideT);
    hideT = setTimeout(() => {
        if (state.playing && !el.pNext.classList.contains('show')) el.pUi.classList.add('hide');
    }, 3000);
}

// ===== OPTIMIZACIÓN 5: Manejo mejorado de eventos de video =====
function setupPlayer() {
    const v = el.vid;

    // Configuración óptima del video
    v.preload = 'auto';
    v.playsInline = true;

    v.addEventListener('loadstart', () => { 
        el.pLoad.classList.add('show'); 
        el.pErr.classList.remove('show'); 
        el.pLoadTxt.textContent = 'Conectando...';
        updateStatus('Conectando...');
    });

    v.addEventListener('loadedmetadata', () => {
        el.pLoadTxt.textContent = 'Cargando video...';
        updateStatus('Preparando...');
    });

    v.addEventListener('loadeddata', () => {
        el.pLoadTxt.textContent = 'Casi listo...';
    });

    v.addEventListener('canplay', () => {
        el.pLoad.classList.remove('show');
        updateStatus('');
        state.retryCount = 0; // Reset retry count on success
    });

    v.addEventListener('canplaythrough', () => {
        el.pLoad.classList.remove('show');
        updateStatus('');
    });

    v.addEventListener('waiting', () => { 
        el.pLoad.classList.add('show');
        el.pLoadTxt.textContent = 'Buffering...';
        updateStatus('Buffering...');
    });

    v.addEventListener('playing', () => { 
        el.pLoad.classList.remove('show'); 
        state.playing = true; 
        el.pPp.textContent = 'PAUSE'; 
        hideNext();
        updateStatus('');
        startBufferMonitor();
    });

    v.addEventListener('pause', () => { 
        state.playing = false; 
        el.pPp.textContent = 'PLAY';
        stopBufferMonitor();
    });

    v.addEventListener('timeupdate', () => { 
        updateProg(); 
        checkNext(); 
    });

    v.addEventListener('progress', updateBuf);

    v.addEventListener('durationchange', () => { 
        el.pDur.textContent = fmt(v.duration); 
    });

    v.addEventListener('volumechange', updateVol);

    v.addEventListener('ended', () => {
        stopBufferMonitor();
        showNext();
    });

    // ===== OPTIMIZACIÓN 6: Manejo mejorado de errores =====
    v.addEventListener('error', handleVideoError);

    v.addEventListener('stalled', () => {
        console.log('Stream stalled, checking connection...');
        updateStatus('Reconectando...');
        el.pLoadTxt.textContent = 'Reconectando...';
    });

    v.addEventListener('suspend', () => {
        console.log('Download suspended');
    });

    el.pPp.onclick = togglePlay;
    el.pRw.onclick = () => seek(-10);
    el.pFw.onclick = () => seek(10);
    el.pPrev.onclick = prevEp;
    el.pNxt.onclick = nextEp;
    el.pRetry.onclick = retry;
    el.pBack.onclick = () => history.back();
    el.pNextPlay.onclick = nextEp;
    el.pNextCancel.onclick = cancelNext;
    el.pBar.onclick = e => {
        const r = el.pBar.getBoundingClientRect();
        const percent = (e.clientX - r.left) / r.width;
        el.vid.currentTime = percent * el.vid.duration;
    };
}

function handleVideoError(e) {
    console.error('Video error:', e);
    const error = el.vid.error;
    let msg = 'Error desconocido';

    if (error) {
        switch(error.code) {
            case 1: msg = 'Carga abortada'; break;
            case 2: msg = 'Error de red'; break;
            case 3: msg = 'Error de decodificación'; break;
            case 4: msg = 'Formato no soportado'; break;
        }
    }

    el.pErrSub.textContent = msg;

    // Auto-retry para errores de red
    if (error && error.code === 2 && state.retryCount < state.maxRetries) {
        state.retryCount++;
        el.pLoadTxt.textContent = 'Reintentando... (' + state.retryCount + '/' + state.maxRetries + ')';
        updateStatus('Reintentando...');
        setTimeout(retry, 2000);
    } else {
        el.pLoad.classList.remove('show'); 
        el.pErr.classList.add('show');
        stopBufferMonitor();
    }
}

function handlePlayError(e) {
    console.error('Play error:', e);
    if (e.name === 'NotAllowedError') {
        // Autoplay blocked, show play button
        el.pPp.textContent = 'PLAY';
    }
}

function updateStatus(text) {
    el.pStatus.textContent = text;
}

// ===== OPTIMIZACIÓN 7: Monitor de buffer =====
function startBufferMonitor() {
    stopBufferMonitor();
    bufferCheckT = setInterval(() => {
        if (el.vid.buffered.length > 0) {
            const buffered = el.vid.buffered.end(el.vid.buffered.length - 1);
            const current = el.vid.currentTime;
            const bufferAhead = buffered - current;

            if (bufferAhead < 2 && !el.vid.paused) {
                updateStatus('Buffer bajo...');
            } else if (bufferAhead > 5) {
                updateStatus('');
            }
        }
    }, 1000);
}

function stopBufferMonitor() {
    if (bufferCheckT) {
        clearInterval(bufferCheckT);
        bufferCheckT = null;
    }
}

function updateProg() {
    const p = el.vid.duration ? (el.vid.currentTime / el.vid.duration) * 100 : 0;
    el.pBarFill.style.width = p + '%';
    el.pBarDot.style.left = p + '%';
    el.pCur.textContent = fmt(el.vid.currentTime);
}

function updateBuf() {
    if (el.vid.buffered.length) {
        const p = (el.vid.buffered.end(el.vid.buffered.length - 1) / el.vid.duration) * 100;
        el.pBarBuf.style.width = p + '%';
    }
}

function retry() {
    el.pErr.classList.remove('show');
    el.pLoad.classList.add('show');
    el.pLoadTxt.textContent = 'Reintentando...';

    const currentTime = el.vid.currentTime;
    const src = el.vid.src;

    el.vid.src = '';

    // Pequeño delay antes de reintentar
    setTimeout(() => {
        el.vid.src = src;
        el.vid.currentTime = currentTime;
        el.vid.play().catch(handlePlayError);
    }, 500);
}

function checkNext() {
    const rem = (el.vid.duration || 0) - el.vid.currentTime;
    if (rem <= 15 && rem > 0 && hasNext() && !nextT) showNext();
}

function showNext() {
    if (!hasNext()) return;
    const n = getNext();
    el.pNextT.textContent = 'E' + n.ep + ' - ' + n.title;
    el.pNext.classList.add('show');
    let c = 8;
    el.pNextCd.textContent = 'En ' + c + 's';
    nextT = setInterval(() => {
        c--; el.pNextCd.textContent = 'En ' + c + 's';
        if (c <= 0) { clearInterval(nextT); nextT = null; nextEp(); }
    }, 1000);
    showUI();
}

function hideNext() { el.pNext.classList.remove('show'); if (nextT) { clearInterval(nextT); nextT = null; } }
function cancelNext() { hideNext(); }
function hasNext() { return state.series && state.epIdx < state.series.seasons[state.season].length - 1; }
function getNext() { return state.series.seasons[state.season][state.epIdx + 1]; }
function nextEp() { hideNext(); if (hasNext()) { state.epIdx++; playEp(state.series.seasons[state.season][state.epIdx]); } }
function prevEp() { if (state.epIdx > 0) { state.epIdx--; playEp(state.series.seasons[state.season][state.epIdx]); } }

// ===== OPTIMIZACIÓN 8: Función de reproducción mejorada =====
function playEp(ep) {
    state.retryCount = 0;
    hideNext();
    el.pErr.classList.remove('show');
    el.pLoad.classList.add('show');
    el.pLoadTxt.textContent = 'Conectando...';

    let u = ep.url;
    // Usar proxy para URLs HTTP o si hay problemas de CORS
    if (u.startsWith('http://') || shouldUseProxy(u)) {
        u = '/video-proxy?url=' + encodeURIComponent(u);
    }

    // Limpiar video anterior
    el.vid.pause();
    el.vid.removeAttribute('src');
    el.vid.load();

    // Pequeño delay para asegurar limpieza
    setTimeout(() => {
        el.vid.src = u;
        el.pTitle.textContent = ep.title;
        el.vid.play().catch(handlePlayError);
        showUI();
    }, 100);
}

function shouldUseProxy(url) {
    // Lista de dominios que necesitan proxy
    const proxyDomains = ['example.com']; // Añadir dominios problemáticos
    try {
        const parsed = new URL(url);
        return proxyDomains.some(d => parsed.hostname.includes(d));
    } catch {
        return false;
    }
}

function fmt(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60);
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') : m + ':' + String(ss).padStart(2, '0');
}

// ===== SERIES =====
function load(append, random) {
    if (state.loading || (append && !state.hasMore)) return;
    state.loading = true;
    if (!append) { el.grid.innerHTML = '<div class="msg load">Cargando</div>'; state.page = 0; state.hasMore = true; }

    let u = '/api/series?page=' + state.page + '&limit=250';
    if (el.srch.value.trim()) u += '&q=' + encodeURIComponent(el.srch.value.trim());
    if (random) u += '&random=true';

    fetch(u).then(r => r.json()).then(d => {
        if (!append) el.grid.innerHTML = '';
        if (!d.data.length && !append) { el.grid.innerHTML = '<div class="msg">Sin resultados</div>'; return; }
        d.data.forEach(s => el.grid.appendChild(mkCard(s)));
        state.page++; state.hasMore = d.hasMore;
        calcCols();
        if (!append) setTimeout(focusFirst, 50);
    }).catch(() => {
        if (!append) el.grid.innerHTML = '<div class="msg">Error</div>';
    }).finally(() => state.loading = false);
}

function mkCard(s) {
    const d = document.createElement('div');
    d.className = 'card';
    d.innerHTML = '<img data-src="' + esc(s.poster) + '"><div class="card-t">' + esc(s.name) + '</div>';
    const img = d.querySelector('img');
    obs.observe(img);
    d.onclick = () => openDetail(s.name);
    return d;
}

const obs = new IntersectionObserver(es => {
    es.forEach(e => {
        if (e.isIntersecting) {
            const i = e.target;
            if (i.dataset.src) { i.src = i.dataset.src; i.onload = () => i.classList.add('ok'); i.onerror = () => i.classList.add('err'); }
            obs.unobserve(i);
        }
    });
}, { rootMargin: '200px' });

// ===== DETAIL =====
function openDetail(name) {
    saveFocus();
    state.view = 'detail';
    state.lastFocused.detail = null;
    pushView('detail');
    el.detTitle.textContent = name;
    el.detail.classList.add('open');
    el.tabs.innerHTML = '<div class="msg load"></div>';
    el.eps.innerHTML = '';

    fetch('/api/series/' + encodeURIComponent(name)).then(r => r.json()).then(res => {
        state.series = res.data;
        const ks = Object.keys(state.series.seasons).sort((a, b) => a - b);
        state.season = ks[0];
        renderTabs(ks);
        renderEps();
        setTimeout(focusFirst, 50);
    }).catch(() => el.tabs.innerHTML = '<div class="msg">Error</div>');
}

function renderTabs(ks) {
    el.tabs.innerHTML = '';
    ks.forEach(k => {
        const t = document.createElement('button');
        t.className = 'tab' + (k === state.season ? ' on' : '');
        t.textContent = 'T' + k;
        t.onclick = () => {
            state.season = k;
            el.tabs.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x.textContent === 'T' + k));
            renderEps();
        };
        el.tabs.appendChild(t);
    });
}

function renderEps() {
    const eps = state.series?.seasons[state.season];
    if (!eps?.length) { el.eps.innerHTML = '<div class="msg">Sin episodios</div>'; return; }
    el.eps.innerHTML = '';
    eps.forEach((ep, i) => {
        const d = document.createElement('div');
        d.className = 'ep';
        d.innerHTML = '<div class="ep-n">' + ep.ep + '</div><div><div class="ep-t">' + esc(ep.title) + '</div><div class="ep-m">Temporada ' + state.season + '</div></div>';
        d.onclick = () => { state.epIdx = i; openPlayer(ep); };
        el.eps.appendChild(d);
    });
}

function closeDetailInternal() {
    el.detail.classList.remove('open');
    state.view = 'home';
    state.series = null;
    state.lastFocused.detail = null;
    setTimeout(focusFirst, 50);
}

function closeDetail() {
    history.back();
}

// ===== PLAYER =====
function openPlayer(ep) {
    saveFocus();
    state.view = 'player';
    pushView('player');
    playEp(ep);
    el.player.classList.add('open');
}

function closePlayerInternal() {
    el.vid.pause();
    el.vid.removeAttribute('src');
    el.vid.load();
    el.player.classList.remove('open');
    state.view = 'detail';
    hideNext();
    stopBufferMonitor();
    setTimeout(focusFirst, 50);
}

function closePlayer() {
    history.back();
}

// ===== MOUSE =====
function setupMouse() {
    el.detBack.onclick = closeDetail;
    el.mix.onclick = () => load(false, true);
    let t;
    el.srch.oninput = () => { clearTimeout(t); t = setTimeout(() => load(false, !el.srch.value.trim()), 300); };
    el.main.onscroll = () => {
        if (!state.loading && state.hasMore) {
            const { scrollTop, scrollHeight, clientHeight } = el.main;
            if (scrollTop + clientHeight >= scrollHeight - 300) load(true, false);
        }
    };
    el.player.onclick = e => { if (e.target === el.vid) { togglePlay(); showUI(); } };
    el.player.onmousemove = showUI;
    el.player.ontouchmove = showUI;
}

function esc(s) { return s ? String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]) : '' }
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => { res.setHeader('Content-Type', 'text/html'); res.send(HTML); });
app.get('/health', (req, res) => res.json({ ok: true, series: SERIES_LIST.length }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, '0.0.0.0', () => {
    console.log('Stream+ | Puerto ' + PORT + ' | ' + SERIES_LIST.length + ' series');
});
