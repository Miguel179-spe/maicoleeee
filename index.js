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

// ===== CONFIGURACIÓN =====
const config = { 
    DATA_FILES: [
        process.env.DATA_FILE || 'data.json',
        process.env.DATA_FILE_2 || 'data_backup1.json',
        process.env.DATA_FILE_3 || 'data_backup2.json',
        process.env.DATA_FILE_4 || 'data_backup3.json'
    ],
    // Configuración de detección de caídas
    HEALTH_CHECK_INTERVAL: 60000,        // Verificar cada 1 minuto
    URLS_TO_TEST: 5,                      // URLs a probar por verificación
    URL_TEST_TIMEOUT: 8000,               // Timeout para probar URL (8s para Render)
    FAILURE_THRESHOLD: 3,                 // Fallos consecutivos para marcar como caído
    SUCCESS_THRESHOLD: 2,                 // Éxitos consecutivos para recuperar
    RECOVERY_CHECK_INTERVAL: 300000,      // Verificar recuperación cada 5 min
    MAX_CONCURRENT_CHECKS: 3              // Máximo de verificaciones simultáneas
};

// ===== MIDDLEWARE =====
app.use(compression({
    filter: (req, res) => {
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
    max: 500,
    skip: (req) => req.headers.range
});

// ===== ESTADO GLOBAL =====
let SERIES_LIST = [];
let SERIES_INDEX = {};
let TOTAL_EPISODES = 0;
let DATA_SOURCES = {};
let ACTIVE_SOURCE = null;
let SOURCE_HEALTH = {};
let FAILED_URLS_CACHE = new Map();      // Cache de URLs que fallaron recientemente
let HEALTH_CHECK_RUNNING = false;

// ===== LOGGING MEJORADO PARA RENDER =====
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logMsg = `[${timestamp}] [${level}] ${message}`;
    if (data) {
        console.log(logMsg, JSON.stringify(data));
    } else {
        console.log(logMsg);
    }
}

// ===== CARGA DE DATOS =====
function loadDataFromFile(filename) {
    try {
        const jsonPath = path.join(__dirname, filename);
        if (!fs.existsSync(jsonPath)) {
            log('INFO', `Archivo no encontrado: ${filename}`);
            return null;
        }
        
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        if (!Array.isArray(data)) {
            log('WARN', `Formato inválido en: ${filename}`);
            return null;
        }

        const totalEpisodes = data.length;
        const map = {};
        const allUrls = [];
        
        data.forEach(item => {
            const name = item.series || 'Sin nombre';
            const season = String(item.season || '1');
            if (!map[name]) map[name] = { name, poster: item["logo serie"] || '', seasons: {}, count: 0 };
            if (!map[name].seasons[season]) map[name].seasons[season] = [];
            
            const url = item.url || '';
            map[name].seasons[season].push({ 
                ep: item.ep || 1, 
                title: item.title || 'Episodio ' + (item.ep || 1), 
                url: url,
                source: filename
            });
            map[name].count++;
            
            // Guardar URLs para verificación
            if (url) allUrls.push(url);
        });

        Object.values(map).forEach(s => 
            Object.keys(s.seasons).forEach(k => 
                s.seasons[k].sort((a, b) => a.ep - b.ep)
            )
        );
        
        const seriesList = Object.values(map)
            .map(s => ({ 
                name: s.name, 
                poster: s.poster, 
                seasons: Object.keys(s.seasons).length, 
                count: s.count 
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        log('OK', `Cargado ${filename}: ${seriesList.length} series, ${totalEpisodes} episodios`);
        
        return {
            raw: data,
            seriesIndex: map,
            seriesList: seriesList,
            totalEpisodes: totalEpisodes,
            allUrls: allUrls,
            status: 'loaded'
        };
    } catch (e) { 
        log('ERROR', `Error cargando ${filename}: ${e.message}`);
        return null;
    }
}

function loadAllDataSources() {
    log('INIT', 'Cargando fuentes de datos...');
    
    config.DATA_FILES.forEach((filename, index) => {
        const data = loadDataFromFile(filename);
        if (data) {
            DATA_SOURCES[filename] = data;
            SOURCE_HEALTH[filename] = { 
                status: 'unknown',           // unknown, healthy, degraded, down
                healthy: true,
                priority: index,
                totalUrls: data.allUrls.length,
                testedUrls: 0,
                failedUrls: 0,
                consecutiveFailures: 0,
                consecutiveSuccesses: 0,
                lastCheck: null,
                lastSuccess: null,
                lastFailure: null,
                failureRate: 0
            };
        }
    });

    const sourceCount = Object.keys(DATA_SOURCES).length;
    log('INIT', `${sourceCount} fuentes de datos cargadas`);
    
    if (sourceCount === 0) {
        log('CRITICAL', 'No hay fuentes de datos disponibles');
    } else {
        // Activar primera fuente y comenzar verificación
        selectBestSource();
        
        // Verificación inicial después de 10 segundos (dar tiempo a Render)
        setTimeout(() => {
            performHealthCheck();
        }, 10000);
    }
}

// ===== VERIFICACIÓN DE SALUD DE URLs =====
function testUrl(url, timeout = config.URL_TEST_TIMEOUT) {
    return new Promise((resolve) => {
        const startTime = Date.now();
        
        try {
            const parsed = new URL(url);
            const client = parsed.protocol === 'https:' ? https : http;
            
            const req = client.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'HEAD',
                timeout: timeout,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': '*/*'
                }
            }, (res) => {
                const responseTime = Date.now() - startTime;
                const success = res.statusCode >= 200 && res.statusCode < 400;
                
                resolve({
                    ok: success,
                    status: res.statusCode,
                    responseTime: responseTime,
                    url: url
                });
            });

            req.on('error', (err) => {
                resolve({ 
                    ok: false, 
                    status: 0, 
                    error: err.message,
                    responseTime: Date.now() - startTime,
                    url: url
                });
            });
            
            req.on('timeout', () => {
                req.destroy();
                resolve({ 
                    ok: false, 
                    status: 0, 
                    error: 'timeout',
                    responseTime: timeout,
                    url: url
                });
            });
            
            req.end();
        } catch (e) {
            resolve({ 
                ok: false, 
                status: 0, 
                error: e.message,
                responseTime: 0,
                url: url
            });
        }
    });
}

async function testMultipleUrls(urls, maxConcurrent = config.MAX_CONCURRENT_CHECKS) {
    const results = [];
    
    // Procesar en lotes para no sobrecargar
    for (let i = 0; i < urls.length; i += maxConcurrent) {
        const batch = urls.slice(i, i + maxConcurrent);
        const batchResults = await Promise.all(batch.map(url => testUrl(url)));
        results.push(...batchResults);
    }
    
    return results;
}

function getRandomUrls(urls, count) {
    const shuffled = [...urls].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, urls.length));
}

async function checkSourceHealth(filename) {
    const sourceData = DATA_SOURCES[filename];
    const health = SOURCE_HEALTH[filename];
    
    if (!sourceData || !health) return;
    
    // Seleccionar URLs aleatorias para probar
    const urlsToTest = getRandomUrls(sourceData.allUrls, config.URLS_TO_TEST);
    
    if (urlsToTest.length === 0) {
        log('WARN', `No hay URLs para probar en ${filename}`);
        return;
    }
    
    log('HEALTH', `Verificando ${urlsToTest.length} URLs de ${filename}...`);
    
    const results = await testMultipleUrls(urlsToTest);
    
    const successful = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const failureRate = (failed / results.length) * 100;
    
    // Actualizar estadísticas
    health.testedUrls += results.length;
    health.failedUrls += failed;
    health.lastCheck = Date.now();
    health.failureRate = failureRate;
    
    // Lógica de detección de caídas
    if (failureRate >= 60) {
        // Más del 60% falló
        health.consecutiveFailures++;
        health.consecutiveSuccesses = 0;
        health.lastFailure = Date.now();
        
        if (health.consecutiveFailures >= config.FAILURE_THRESHOLD) {
            health.status = 'down';
            health.healthy = false;
            log('ALERT', `⚠️ FUENTE CAÍDA: ${filename} (${failureRate.toFixed(1)}% fallos)`, {
                tested: results.length,
                failed: failed,
                consecutiveFailures: health.consecutiveFailures
            });
        } else {
            health.status = 'degraded';
            log('WARN', `Fuente degradada: ${filename} (${failureRate.toFixed(1)}% fallos)`);
        }
    } else if (failureRate >= 30) {
        // Entre 30-60% falló
        health.status = 'degraded';
        health.consecutiveSuccesses = 0;
        log('WARN', `Fuente con problemas: ${filename} (${failureRate.toFixed(1)}% fallos)`);
    } else {
        // Menos del 30% falló - saludable
        health.consecutiveSuccesses++;
        health.consecutiveFailures = 0;
        health.lastSuccess = Date.now();
        
        if (health.consecutiveSuccesses >= config.SUCCESS_THRESHOLD || health.status === 'unknown') {
            health.status = 'healthy';
            health.healthy = true;
        }
        
        log('OK', `Fuente OK: ${filename} (${(100 - failureRate).toFixed(1)}% éxito)`);
    }
    
    // Guardar URLs fallidas en cache
    results.filter(r => !r.ok).forEach(r => {
        FAILED_URLS_CACHE.set(r.url, {
            lastFail: Date.now(),
            source: filename,
            error: r.error || `HTTP ${r.status}`
        });
    });
    
    return {
        filename,
        tested: results.length,
        successful,
        failed,
        failureRate,
        status: health.status
    };
}

async function performHealthCheck() {
    if (HEALTH_CHECK_RUNNING) {
        log('INFO', 'Verificación de salud ya en progreso, saltando...');
        return;
    }
    
    HEALTH_CHECK_RUNNING = true;
    log('HEALTH', '=== Iniciando verificación de salud ===');
    
    try {
        const results = [];
        
        // Verificar todas las fuentes
        for (const filename of Object.keys(DATA_SOURCES)) {
            const result = await checkSourceHealth(filename);
            if (result) results.push(result);
        }
        
        // Seleccionar mejor fuente
        const previousSource = ACTIVE_SOURCE;
        selectBestSource();
        
        if (previousSource !== ACTIVE_SOURCE) {
            log('SWITCH', `🔄 CAMBIO DE FUENTE: ${previousSource} → ${ACTIVE_SOURCE}`);
        }
        
        // Limpiar cache de URLs fallidas antiguas (más de 30 min)
        const thirtyMinAgo = Date.now() - 1800000;
        for (const [url, data] of FAILED_URLS_CACHE.entries()) {
            if (data.lastFail < thirtyMinAgo) {
                FAILED_URLS_CACHE.delete(url);
            }
        }
        
        log('HEALTH', '=== Verificación completada ===', {
            sources: results.map(r => ({ name: r.filename, status: r.status, failRate: r.failureRate.toFixed(1) + '%' })),
            activeSource: ACTIVE_SOURCE
        });
        
    } catch (error) {
        log('ERROR', `Error en verificación de salud: ${error.message}`);
    } finally {
        HEALTH_CHECK_RUNNING = false;
    }
}

function selectBestSource() {
    const sources = Object.entries(SOURCE_HEALTH)
        .filter(([filename]) => DATA_SOURCES[filename])
        .sort((a, b) => {
            const [, healthA] = a;
            const [, healthB] = b;
            
            // Primero por estado de salud
            const statusOrder = { healthy: 0, unknown: 1, degraded: 2, down: 3 };
            const statusDiff = (statusOrder[healthA.status] || 4) - (statusOrder[healthB.status] || 4);
            if (statusDiff !== 0) return statusDiff;
            
            // Luego por tasa de fallos
            if (healthA.failureRate !== healthB.failureRate) {
                return healthA.failureRate - healthB.failureRate;
            }
            
            // Finalmente por prioridad original
            return healthA.priority - healthB.priority;
        });

    if (sources.length > 0) {
        const [bestSource, health] = sources[0];
        
        if (ACTIVE_SOURCE !== bestSource) {
            log('SOURCE', `Seleccionando fuente: ${bestSource} (estado: ${health.status})`);
            ACTIVE_SOURCE = bestSource;
            
            const sourceData = DATA_SOURCES[bestSource];
            SERIES_INDEX = sourceData.seriesIndex;
            SERIES_LIST = sourceData.seriesList;
            TOTAL_EPISODES = sourceData.totalEpisodes;
        }
    }
}

// ===== REGISTRO DE FALLOS EN TIEMPO REAL =====
function registerPlaybackFailure(url, source, error) {
    log('PLAYBACK_FAIL', `Fallo de reproducción: ${url.substring(0, 60)}...`, { source, error });
    
    // Agregar al cache de fallos
    FAILED_URLS_CACHE.set(url, {
        lastFail: Date.now(),
        source: source || ACTIVE_SOURCE,
        error: error
    });
    
    // Actualizar salud de la fuente
    const sourceFile = source || ACTIVE_SOURCE;
    if (SOURCE_HEALTH[sourceFile]) {
        SOURCE_HEALTH[sourceFile].failedUrls++;
        SOURCE_HEALTH[sourceFile].consecutiveFailures++;
        SOURCE_HEALTH[sourceFile].lastFailure = Date.now();
        
        // Si hay muchos fallos consecutivos, degradar la fuente
        if (SOURCE_HEALTH[sourceFile].consecutiveFailures >= config.FAILURE_THRESHOLD) {
            SOURCE_HEALTH[sourceFile].status = 'down';
            SOURCE_HEALTH[sourceFile].healthy = false;
            log('ALERT', `⚠️ Fuente marcada como caída por fallos de reproducción: ${sourceFile}`);
            
            // Cambiar a otra fuente
            selectBestSource();
        }
    }
}

function registerPlaybackSuccess(url, source) {
    // Remover del cache de fallos si estaba
    if (FAILED_URLS_CACHE.has(url)) {
        FAILED_URLS_CACHE.delete(url);
    }
    
    // Actualizar salud positiva
    const sourceFile = source || ACTIVE_SOURCE;
    if (SOURCE_HEALTH[sourceFile]) {
        SOURCE_HEALTH[sourceFile].consecutiveSuccesses++;
        SOURCE_HEALTH[sourceFile].consecutiveFailures = 0;
        SOURCE_HEALTH[sourceFile].lastSuccess = Date.now();
        
        // Recuperar fuente si estaba degradada
        if (SOURCE_HEALTH[sourceFile].status === 'degraded' && 
            SOURCE_HEALTH[sourceFile].consecutiveSuccesses >= config.SUCCESS_THRESHOLD) {
            SOURCE_HEALTH[sourceFile].status = 'healthy';
            SOURCE_HEALTH[sourceFile].healthy = true;
            log('RECOVERY', `✅ Fuente recuperada: ${sourceFile}`);
        }
    }
}

// ===== BÚSQUEDA DE ALTERNATIVAS =====
function findAlternativeUrl(seriesName, season, episodeNum) {
    for (const [filename, sourceData] of Object.entries(DATA_SOURCES)) {
        // Saltar fuente activa y fuentes caídas
        if (filename === ACTIVE_SOURCE) continue;
        if (SOURCE_HEALTH[filename]?.status === 'down') continue;
        
        const series = sourceData.seriesIndex[seriesName];
        if (series && series.seasons[season]) {
            const episode = series.seasons[season].find(ep => ep.ep === episodeNum);
            if (episode && episode.url) {
                // Verificar que la URL no esté en cache de fallidas
                if (!FAILED_URLS_CACHE.has(episode.url)) {
                    log('ALT', `Alternativa encontrada en: ${filename}`);
                    return {
                        url: episode.url,
                        source: filename
                    };
                }
            }
        }
    }
    
    return null;
}

// ===== INICIALIZACIÓN =====
loadAllDataSources();

// Verificación periódica de salud
setInterval(() => {
    performHealthCheck();
}, config.HEALTH_CHECK_INTERVAL);

// Verificación de recuperación de fuentes caídas
setInterval(() => {
    const downSources = Object.entries(SOURCE_HEALTH)
        .filter(([, health]) => health.status === 'down');
    
    if (downSources.length > 0) {
        log('RECOVERY', `Verificando recuperación de ${downSources.length} fuentes caídas...`);
        downSources.forEach(([filename]) => {
            // Resetear contadores para dar oportunidad
            SOURCE_HEALTH[filename].consecutiveFailures = 0;
            SOURCE_HEALTH[filename].status = 'degraded';
        });
    }
}, config.RECOVERY_CHECK_INTERVAL);

// ===== CORS =====
app.use((req, res, next) => { 
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next(); 
});

// ===== API ENDPOINTS =====
app.get('/api/stats', (req, res) => {
    const healthySources = Object.values(SOURCE_HEALTH).filter(h => h.status === 'healthy').length;
    const totalSources = Object.keys(DATA_SOURCES).length;
    
    res.json({ 
        series: SERIES_LIST.length, 
        episodes: TOTAL_EPISODES,
        activeSource: ACTIVE_SOURCE,
        activeSourceStatus: SOURCE_HEALTH[ACTIVE_SOURCE]?.status || 'unknown',
        sourcesCount: totalSources,
        healthySources: healthySources,
        degradedSources: Object.values(SOURCE_HEALTH).filter(h => h.status === 'degraded').length,
        downSources: Object.values(SOURCE_HEALTH).filter(h => h.status === 'down').length
    });
});

app.get('/api/health', (req, res) => {
    const sources = Object.entries(SOURCE_HEALTH).map(([filename, health]) => ({
        filename,
        status: health.status,
        healthy: health.healthy,
        failureRate: health.failureRate?.toFixed(1) + '%',
        testedUrls: health.testedUrls,
        failedUrls: health.failedUrls,
        consecutiveFailures: health.consecutiveFailures,
        lastCheck: health.lastCheck ? new Date(health.lastCheck).toISOString() : null,
        lastFailure: health.lastFailure ? new Date(health.lastFailure).toISOString() : null,
        isActive: filename === ACTIVE_SOURCE
    }));
    
    res.json({ 
        activeSource: ACTIVE_SOURCE,
        sources,
        failedUrlsInCache: FAILED_URLS_CACHE.size,
        lastHealthCheck: HEALTH_CHECK_RUNNING ? 'running' : 'idle'
    });
});

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

app.get('/api/alternative-url', (req, res) => {
    const { series, season, episode } = req.query;
    
    if (!series || !season || !episode) {
        return res.status(400).json({ error: 'Parámetros requeridos: series, season, episode' });
    }
    
    const alt = findAlternativeUrl(series, season, parseInt(episode));
    
    if (alt) {
        res.json({ found: true, url: alt.url, source: alt.source });
    } else {
        res.json({ found: false, reason: 'No hay alternativas disponibles' });
    }
});

// Endpoint para reportar fallo de reproducción desde el cliente
app.post('/api/report-failure', express.json(), (req, res) => {
    const { url, source, error, series, season, episode } = req.body;
    
    if (url) {
        registerPlaybackFailure(url, source, error || 'unknown');
        
        // Buscar alternativa
        if (series && season && episode) {
            const alt = findAlternativeUrl(series, season, parseInt(episode));
            if (alt) {
                return res.json({ 
                    reported: true, 
                    alternative: alt 
                });
            }
        }
    }
    
    res.json({ reported: true, alternative: null });
});

// Endpoint para reportar éxito de reproducción
app.post('/api/report-success', express.json(), (req, res) => {
    const { url, source } = req.body;
    
    if (url) {
        registerPlaybackSuccess(url, source);
    }
    
    res.json({ reported: true });
});

// Forzar verificación de salud manualmente
app.get('/api/force-health-check', async (req, res) => {
    if (HEALTH_CHECK_RUNNING) {
        return res.json({ status: 'already_running' });
    }
    
    performHealthCheck();
    res.json({ status: 'started' });
});

// ===== VIDEO PROXY CON DETECCIÓN DE FALLOS =====
app.get('/video-proxy', videoProxyLimiter, (req, res) => {
    const url = req.query.url;
    const source = req.query.source || ACTIVE_SOURCE;
    const seriesName = req.query.series;
    const season = req.query.season;
    const episode = req.query.episode ? parseInt(req.query.episode) : null;
    
    if (!url) return res.status(400).json({ error: 'URL requerida' });

    // Verificar si la URL está en cache de fallidas
    if (FAILED_URLS_CACHE.has(decodeURIComponent(url))) {
        const cached = FAILED_URLS_CACHE.get(decodeURIComponent(url));
        // Si falló hace menos de 5 minutos, buscar alternativa directamente
        if (Date.now() - cached.lastFail < 300000) {
            log('CACHE_HIT', `URL en cache de fallos, buscando alternativa`);
            
            if (seriesName && season && episode) {
                const alt = findAlternativeUrl(seriesName, season, episode);
                if (alt) {
                    return res.redirect('/video-proxy?url=' + encodeURIComponent(alt.url) + 
                        '&source=' + alt.source +
                        '&series=' + encodeURIComponent(seriesName) +
                        '&season=' + season +
                        '&episode=' + episode);
                }
            }
        }
    }

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
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
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
            return res.redirect('/video-proxy?url=' + encodeURIComponent(proxyRes.headers.location) + 
                (source ? '&source=' + source : '') +
                (seriesName ? '&series=' + encodeURIComponent(seriesName) : '') +
                (season ? '&season=' + season : '') +
                (episode ? '&episode=' + episode : ''));
        }

        if (proxyRes.statusCode >= 400) {
            proxyRes.destroy();
            
            // Registrar fallo
            registerPlaybackFailure(decodeURIComponent(url), source, `HTTP ${proxyRes.statusCode}`);
            
            // Buscar alternativa
            if (seriesName && season && episode) {
                const alt = findAlternativeUrl(seriesName, season, episode);
                if (alt) {
                    log('REDIRECT', `Redirigiendo a alternativa: ${alt.source}`);
                    return res.redirect('/video-proxy?url=' + encodeURIComponent(alt.url) + 
                        '&source=' + alt.source +
                        '&series=' + encodeURIComponent(seriesName) +
                        '&season=' + season +
                        '&episode=' + episode);
                }
            }
            
            return res.status(proxyRes.statusCode).json({ 
                error: 'Error del servidor origen',
                statusCode: proxyRes.statusCode,
                hasAlternative: false
            });
        }

        // Éxito - registrar
        registerPlaybackSuccess(decodeURIComponent(url), source);

        const headers = {
            'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'X-Source': source || ACTIVE_SOURCE  // Header informativo
        };

        if (proxyRes.headers['content-length']) headers['Content-Length'] = proxyRes.headers['content-length'];
        if (proxyRes.headers['content-range']) headers['Content-Range'] = proxyRes.headers['content-range'];

        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });

        proxyRes.on('error', (err) => {
            registerPlaybackFailure(decodeURIComponent(url), source, err.message);
            if (!res.headersSent) res.status(502).json({ error: 'Stream error' });
            else res.end();
        });
    });

    proxyReq.on('timeout', () => {
        proxyReq.destroy();
        registerPlaybackFailure(decodeURIComponent(url), source, 'timeout');
        
        if (!res.headersSent) {
            if (seriesName && season && episode) {
                const alt = findAlternativeUrl(seriesName, season, episode);
                if (alt) {
                    return res.redirect('/video-proxy?url=' + encodeURIComponent(alt.url) + 
                        '&source=' + alt.source +
                        '&series=' + encodeURIComponent(seriesName) +
                        '&season=' + season +
                        '&episode=' + episode);
                }
            }
            res.status(504).json({ error: 'Timeout' });
        }
    });

    proxyReq.on('error', (err) => {
        registerPlaybackFailure(decodeURIComponent(url), source, err.message);
        
        if (!res.headersSent) {
            if (seriesName && season && episode) {
                const alt = findAlternativeUrl(seriesName, season, episode);
                if (alt) {
                    return res.redirect('/video-proxy?url=' + encodeURIComponent(alt.url) + 
                        '&source=' + alt.source +
                        '&series=' + encodeURIComponent(seriesName) +
                        '&season=' + season +
                        '&episode=' + episode);
                }
            }
            res.status(502).json({ error: 'Connection error' });
        }
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
:root{--bg:#0a0a0a;--surface:#161616;--card:#1a1a1a;--border:#2a2a2a;--text:#e0e0e0;--text2:#707070;--accent:#c00;--focus:#fff;--success:#0c0;--warning:#fa0;--danger:#f44}
html,body{background:var(--bg);color:var(--text);font-family:-apple-system,system-ui,sans-serif;height:100%;overflow:hidden}
#app{height:100%;display:flex;flex-direction:column}

.hdr{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);flex-wrap:wrap}
.logo{color:var(--accent);font-weight:700;font-size:20px;letter-spacing:-1px}
.srch{flex:1;min-width:150px;background:var(--bg);border:2px solid var(--border);color:var(--text);padding:10px 16px;border-radius:8px;font-size:14px;outline:none}
.srch:focus{border-color:var(--focus)}
.btn{background:var(--card);border:2px solid var(--border);color:var(--text);padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.stats{color:var(--text2);font-size:12px}
.health-ind{display:flex;align-items:center;gap:6px;font-size:11px;padding:4px 10px;border-radius:12px;font-weight:600}
.health-ind.healthy{background:#0c02;color:var(--success)}
.health-ind.degraded{background:#fa02;color:var(--warning)}
.health-ind.down{background:#f442;color:var(--danger)}
.health-dot{width:8px;height:8px;border-radius:50%;animation:pulse 2s infinite}
.healthy .health-dot{background:var(--success)}
.degraded .health-dot{background:var(--warning)}
.down .health-dot{background:var(--danger)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}

.main{flex:1;overflow-y:auto;padding:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px}
@media(min-width:900px){.grid{grid-template-columns:repeat(auto-fill,minmax(160px,1fr))}}

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
.panel-title{flex:1;font-size:18px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.tabs{display:flex;gap:8px;padding:12px 16px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto}
.tab{padding:8px 18px;background:var(--bg);border:2px solid var(--border);border-radius:6px;color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap}
.tab.on{background:var(--accent);border-color:var(--accent);color:#fff}

.list{flex:1;overflow-y:auto;padding:12px}
.ep{display:flex;align-items:center;gap:14px;padding:14px 16px;background:var(--card);border:2px solid transparent;border-radius:8px;margin-bottom:8px;cursor:pointer}
.ep.f{border-color:var(--focus);background:var(--surface)}
.ep-n{width:36px;height:36px;background:var(--accent);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700}
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
.p-source{font-size:10px;color:var(--accent);margin-top:2px}

.p-center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:48px;font-weight:700;opacity:0;transition:opacity .15s}
.p-center.show{opacity:1}

.p-bottom{padding:16px 20px 20px;background:linear-gradient(transparent,#000a)}
.p-prog{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.p-time{font-size:13px;font-weight:500;min-width:50px}
.p-time:last-child{text-align:right}
.p-bar{flex:1;height:4px;background:#444;border-radius:2px;position:relative;cursor:pointer}
.p-bar-fill{position:absolute;left:0;top:0;height:100%;background:var(--accent);border-radius:2px;z-index:2}
.p-bar-buf{position:absolute;left:0;top:0;height:100%;background:#666;border-radius:2px}

.p-ctrl{display:flex;justify-content:center;gap:12px}
.p-btn{width:48px;height:48px;background:transparent;border:2px solid transparent;border-radius:50%;color:#fff;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center}
.p-btn.main{width:56px;height:56px;background:#222;font-size:16px}

.p-err{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;display:none;max-width:90%}
.p-err.show{display:block}
.p-err-t{font-size:16px;margin-bottom:8px}
.p-err-sub{font-size:12px;color:var(--text2);margin-bottom:16px}
.p-err-btn{padding:12px 24px;background:var(--accent);border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin:4px}
.p-err-btn.sec{background:transparent;border:1px solid var(--border)}

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
        <input class="srch" id="srch" placeholder="Buscar...">
        <button class="btn" id="mix">🎲</button>
        <span class="stats" id="stats"></span>
        <div class="health-ind" id="health"><span class="health-dot"></span><span id="health-txt">--</span></div>
    </div>
    <div class="main" id="main"><div class="grid" id="grid"><div class="msg load">Cargando</div></div></div>

    <div class="panel" id="detail">
        <div class="panel-hdr"><button class="back" id="det-back">◀</button><div class="panel-title" id="det-title"></div></div>
        <div class="tabs" id="tabs"></div>
        <div class="list" id="eps"></div>
    </div>

    <div class="player" id="player">
        <video id="vid" playsinline preload="auto"></video>
        <div class="p-load" id="p-load"><div class="p-load-spin"></div><div class="p-load-txt" id="p-load-txt">Cargando...</div></div>
        <div class="p-err" id="p-err">
            <div class="p-err-t">Error de reproducción</div>
            <div class="p-err-sub" id="p-err-sub">No se pudo cargar</div>
            <button class="p-err-btn" id="p-retry">Reintentar</button>
            <button class="p-err-btn" id="p-alt">Buscar alternativa</button>
            <button class="p-err-btn sec" id="p-back">Volver</button>
        </div>
        <div class="p-center" id="p-ind"></div>
        <div class="p-ui" id="p-ui">
            <div class="p-top">
                <div class="p-title" id="p-title"></div>
                <div class="p-status" id="p-status"></div>
                <div class="p-source" id="p-source"></div>
            </div>
            <div class="p-bottom">
                <div class="p-prog">
                    <span class="p-time" id="p-cur">0:00</span>
                    <div class="p-bar" id="p-bar"><div class="p-bar-buf" id="p-bar-buf"></div><div class="p-bar-fill" id="p-bar-fill"></div></div>
                    <span class="p-time" id="p-dur">0:00</span>
                </div>
                <div class="p-ctrl">
                    <button class="p-btn" id="p-prev">⏮</button>
                    <button class="p-btn" id="p-rw">-10</button>
                    <button class="p-btn main" id="p-pp">▶</button>
                    <button class="p-btn" id="p-fw">+10</button>
                    <button class="p-btn" id="p-nxt">⏭</button>
                </div>
            </div>
        </div>
    </div>
</div>
<script>
(function(){
const $=id=>document.getElementById(id);
const state={view:'home',series:null,seriesName:null,season:null,epIdx:0,currentEp:null,page:0,hasMore:true,loading:false,retryCount:0,altAttempts:0};

const el={
    grid:$('grid'),main:$('main'),srch:$('srch'),mix:$('mix'),stats:$('stats'),health:$('health'),healthTxt:$('health-txt'),
    detail:$('detail'),detBack:$('det-back'),detTitle:$('det-title'),tabs:$('tabs'),eps:$('eps'),
    player:$('player'),vid:$('vid'),pUi:$('p-ui'),pTitle:$('p-title'),pStatus:$('p-status'),pSource:$('p-source'),
    pLoad:$('p-load'),pLoadTxt:$('p-load-txt'),pErr:$('p-err'),pErrSub:$('p-err-sub'),pRetry:$('p-retry'),pAlt:$('p-alt'),pBack:$('p-back'),
    pInd:$('p-ind'),pBar:$('p-bar'),pBarFill:$('p-bar-fill'),pBarBuf:$('p-bar-buf'),pCur:$('p-cur'),pDur:$('p-dur'),
    pPrev:$('p-prev'),pRw:$('p-rw'),pPp:$('p-pp'),pFw:$('p-fw'),pNxt:$('p-nxt')
};

let hideT;

// Init
history.replaceState({view:'home'},'','#home');
window.addEventListener('popstate',e=>{
    if(state.view==='player'){closePlayer();history.pushState({view:'detail'},'','#detail');}
    else if(state.view==='detail'){closeDetail();history.pushState({view:'home'},'','#home');}
});

loadStats();
load(false,true);
setInterval(loadStats,30000);

function loadStats(){
    fetch('/api/stats').then(r=>r.json()).then(d=>{
        el.stats.textContent=d.series+' series';
        el.health.className='health-ind '+d.activeSourceStatus;
        el.healthTxt.textContent=d.healthySources+'/'+d.sourcesCount;
    }).catch(()=>{});
}

function load(append,random){
    if(state.loading||(append&&!state.hasMore))return;
    state.loading=true;
    if(!append){el.grid.innerHTML='<div class="msg load">Cargando</div>';state.page=0;}
    let u='/api/series?page='+state.page+'&limit=100';
    if(el.srch.value.trim())u+='&q='+encodeURIComponent(el.srch.value.trim());
    if(random)u+='&random=true';
    fetch(u).then(r=>r.json()).then(d=>{
        if(!append)el.grid.innerHTML='';
        if(!d.data.length&&!append){el.grid.innerHTML='<div class="msg">Sin resultados</div>';return;}
        d.data.forEach(s=>el.grid.appendChild(mkCard(s)));
        state.page++;state.hasMore=d.hasMore;
    }).catch(()=>{if(!append)el.grid.innerHTML='<div class="msg">Error</div>';}).finally(()=>state.loading=false);
}

function mkCard(s){
    const d=document.createElement('div');d.className='card';
    d.innerHTML='<img data-src="'+esc(s.poster)+'"><div class="card-t">'+esc(s.name)+'</div>';
    const img=d.querySelector('img');obs.observe(img);
    d.onclick=()=>openDetail(s.name);
    return d;
}

const obs=new IntersectionObserver(es=>{es.forEach(e=>{if(e.isIntersecting){const i=e.target;if(i.dataset.src){i.src=i.dataset.src;i.onload=()=>i.classList.add('ok');i.onerror=()=>i.classList.add('err');}obs.unobserve(i);}});},{rootMargin:'200px'});

function openDetail(name){
    state.view='detail';state.seriesName=name;
    history.pushState({view:'detail'},'','#detail');
    el.detTitle.textContent=name;el.detail.classList.add('open');
    el.tabs.innerHTML='<div class="msg load"></div>';el.eps.innerHTML='';
    fetch('/api/series/'+encodeURIComponent(name)).then(r=>r.json()).then(res=>{
        state.series=res.data;
        const ks=Object.keys(state.series.seasons).sort((a,b)=>a-b);
        state.season=ks[0];
        renderTabs(ks);renderEps();
    }).catch(()=>el.tabs.innerHTML='<div class="msg">Error</div>');
}

function renderTabs(ks){
    el.tabs.innerHTML='';
    ks.forEach(k=>{
        const t=document.createElement('button');
        t.className='tab'+(k===state.season?' on':'');
        t.textContent='T'+k;
        t.onclick=()=>{state.season=k;el.tabs.querySelectorAll('.tab').forEach(x=>x.classList.toggle('on',x.textContent==='T'+k));renderEps();};
        el.tabs.appendChild(t);
    });
}

function renderEps(){
    const eps=state.series?.seasons[state.season];
    if(!eps?.length){el.eps.innerHTML='<div class="msg">Sin episodios</div>';return;}
    el.eps.innerHTML='';
    eps.forEach((ep,i)=>{
        const d=document.createElement('div');d.className='ep';
        d.innerHTML='<div class="ep-n">'+ep.ep+'</div><div><div class="ep-t">'+esc(ep.title)+'</div><div class="ep-m">T'+state.season+'</div></div>';
        d.onclick=()=>{state.epIdx=i;state.currentEp=ep;openPlayer(ep);};
        el.eps.appendChild(d);
    });
}

function closeDetail(){el.detail.classList.remove('open');state.view='home';state.series=null;}

function openPlayer(ep){
    state.view='player';state.altAttempts=0;state.retryCount=0;
    history.pushState({view:'player'},'','#player');
    el.player.classList.add('open');
    playEp(ep);
}

function playEp(ep){
    state.currentEp=ep;
    el.pErr.classList.remove('show');el.pLoad.classList.add('show');
    el.pLoadTxt.textContent='Conectando...';
    el.pTitle.textContent=ep.title;
    el.pSource.textContent='Fuente: '+(ep.source||'principal');
    
    let u=ep.url;
    if(u.startsWith('http://')||!u.startsWith('https://')){
        u='/video-proxy?url='+encodeURIComponent(ep.url);
        if(state.seriesName)u+='&series='+encodeURIComponent(state.seriesName);
        if(state.season)u+='&season='+state.season;
        if(ep.ep)u+='&episode='+ep.ep;
        if(ep.source)u+='&source='+ep.source;
    }
    
    el.vid.src=u;
    el.vid.play().catch(()=>{});
    showUI();
}

function closePlayer(){
    el.vid.pause();el.vid.src='';
    el.player.classList.remove('open');
    state.view='detail';
}

// Player events
el.vid.onloadstart=()=>{el.pLoad.classList.add('show');el.pLoadTxt.textContent='Conectando...';};
el.vid.oncanplay=()=>{el.pLoad.classList.remove('show');state.retryCount=0;state.altAttempts=0;reportSuccess();};
el.vid.onwaiting=()=>{el.pLoad.classList.add('show');el.pLoadTxt.textContent='Buffering...';};
el.vid.onplaying=()=>{el.pLoad.classList.remove('show');el.pPp.textContent='⏸';};
el.vid.onpause=()=>el.pPp.textContent='▶';
el.vid.ontimeupdate=()=>{
    const p=el.vid.duration?(el.vid.currentTime/el.vid.duration)*100:0;
    el.pBarFill.style.width=p+'%';
    el.pCur.textContent=fmt(el.vid.currentTime);
};
el.vid.ondurationchange=()=>el.pDur.textContent=fmt(el.vid.duration);
el.vid.onprogress=()=>{if(el.vid.buffered.length){el.pBarBuf.style.width=(el.vid.buffered.end(el.vid.buffered.length-1)/el.vid.duration)*100+'%';}};
el.vid.onerror=()=>{
    const err=el.vid.error;
    let msg='Error desconocido';
    if(err){
        switch(err.code){
            case 1:msg='Carga abortada';break;
            case 2:msg='Error de red';break;
            case 3:msg='Error de decodificación';break;
            case 4:msg='Formato no soportado';break;
        }
    }
    el.pErrSub.textContent=msg;
    reportFailure(msg);
    
    if(state.retryCount<2){
        state.retryCount++;
        el.pLoadTxt.textContent='Reintentando ('+state.retryCount+'/2)...';
        setTimeout(retry,2000);
    }else if(state.altAttempts<3){
        el.pLoadTxt.textContent='Buscando alternativa...';
        setTimeout(tryAlt,1000);
    }else{
        el.pLoad.classList.remove('show');
        el.pErr.classList.add('show');
    }
};

function reportSuccess(){
    if(!state.currentEp)return;
    fetch('/api/report-success',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:state.currentEp.url,source:state.currentEp.source})}).catch(()=>{});
}

function reportFailure(error){
    if(!state.currentEp)return;
    fetch('/api/report-failure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:state.currentEp.url,source:state.currentEp.source,error:error,series:state.seriesName,season:state.season,episode:state.currentEp.ep})}).catch(()=>{});
}

function retry(){
    el.pErr.classList.remove('show');
    const t=el.vid.currentTime;
    el.vid.src=el.vid.src;
    el.vid.currentTime=t;
    el.vid.play().catch(()=>{});
}

function tryAlt(){
    state.altAttempts++;
    el.pErr.classList.remove('show');el.pLoad.classList.add('show');
    el.pLoadTxt.textContent='Buscando alternativa ('+state.altAttempts+'/3)...';
    
    fetch('/api/alternative-url?series='+encodeURIComponent(state.seriesName)+'&season='+state.season+'&episode='+state.currentEp.ep)
        .then(r=>r.json()).then(d=>{
            if(d.found&&d.url){
                state.currentEp.url=d.url;
                state.currentEp.source=d.source;
                state.retryCount=0;
                playEp(state.currentEp);
            }else{
                if(state.altAttempts<3)setTimeout(tryAlt,1500);
                else{el.pLoad.classList.remove('show');el.pErr.classList.add('show');el.pErrSub.textContent='Sin alternativas';}
            }
        }).catch(()=>{el.pLoad.classList.remove('show');el.pErr.classList.add('show');});
}

el.pPp.onclick=()=>{if(el.vid.paused)el.vid.play();else el.vid.pause();showUI();};
el.pRw.onclick=()=>{el.vid.currentTime=Math.max(0,el.vid.currentTime-10);showInd('-10s');};
el.pFw.onclick=()=>{el.vid.currentTime=Math.min(el.vid.duration,el.vid.currentTime+10);showInd('+10s');};
el.pPrev.onclick=()=>{if(state.epIdx>0){state.epIdx--;state.currentEp=state.series.seasons[state.season][state.epIdx];playEp(state.currentEp);}};
el.pNxt.onclick=()=>{if(state.epIdx<state.series.seasons[state.season].length-1){state.epIdx++;state.currentEp=state.series.seasons[state.season][state.epIdx];playEp(state.currentEp);}};
el.pRetry.onclick=retry;
el.pAlt.onclick=tryAlt;
el.pBack.onclick=()=>history.back();
el.pBar.onclick=e=>{const r=el.pBar.getBoundingClientRect();el.vid.currentTime=(e.clientX-r.left)/r.width*el.vid.duration;};
el.player.onclick=e=>{if(e.target===el.vid){if(el.vid.paused)el.vid.play();else el.vid.pause();showUI();}};
el.player.onmousemove=showUI;

function showUI(){el.pUi.classList.remove('hide');clearTimeout(hideT);hideT=setTimeout(()=>{if(!el.vid.paused)el.pUi.classList.add('hide');},3000);}
function showInd(t){el.pInd.textContent=t;el.pInd.classList.add('show');setTimeout(()=>el.pInd.classList.remove('show'),500);}
function fmt(s){if(!s||isNaN(s))return'0:00';const m=Math.floor(s/60),ss=Math.floor(s%60);return m+':'+String(ss).padStart(2,'0');}

// Controls
el.detBack.onclick=()=>history.back();
el.mix.onclick=()=>load(false,true);
let st;el.srch.oninput=()=>{clearTimeout(st);st=setTimeout(()=>load(false,!el.srch.value.trim()),300);};
el.main.onscroll=()=>{if(!state.loading&&state.hasMore){const{scrollTop,scrollHeight,clientHeight}=el.main;if(scrollTop+clientHeight>=scrollHeight-300)load(true,false);}};

document.onkeydown=e=>{
    if(state.view==='player'){
        if(e.key===' '||e.key==='Enter'){e.preventDefault();if(el.vid.paused)el.vid.play();else el.vid.pause();showUI();}
        if(e.key==='ArrowLeft'){el.vid.currentTime-=10;showInd('-10s');}
        if(e.key==='ArrowRight'){el.vid.currentTime+=10;showInd('+10s');}
    }
};

function esc(s){return s?String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]):''}
})();
</script>
</body>
</html>`;

app.get('/',(req,res)=>{res.setHeader('Content-Type','text/html');res.send(HTML);});
app.get('/health',(req,res)=>res.json({ok:true,series:SERIES_LIST.length,activeSource:ACTIVE_SOURCE,status:SOURCE_HEALTH[ACTIVE_SOURCE]?.status}));
app.use((req,res)=>res.status(404).json({error:'Not found'}));

app.listen(PORT,'0.0.0.0',()=>{
    log('START',`Stream+ iniciado en puerto ${PORT}`);
    log('INFO',`${SERIES_LIST.length} series | ${Object.keys(DATA_SOURCES).length} fuentes`);
});
