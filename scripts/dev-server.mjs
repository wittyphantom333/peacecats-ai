import {
    createReadStream,
    readdirSync,
    statSync,
    watch
} from 'node:fs';
import {
    readFile,
    realpath,
    stat
} from 'node:fs/promises';
import {
    createServer
} from 'node:http';
import {
    isIP
} from 'node:net';
import {
    dirname,
    extname,
    join,
    normalize,
    resolve,
    sep
} from 'node:path';
import {
    fileURLToPath
} from 'node:url';
import {
    hasMapLandingLanguage,
    mapLandingPageById,
    renderMapLandingPage
} from './map-landing-pages.mjs';
import { SEO_PAGE_CONTENT } from './seo-content.mjs';
import { renderSeoGuideContent } from './lib/seo-guide-render.mjs';

const __dirname = dirname(
    fileURLToPath(import.meta.url)
);

const root = resolve(
    __dirname,
    '..'
);

const DEFAULT_HOST =
    '127.0.0.1';

const DEFAULT_PORT =
    8000;

const PUBLIC_STATIC_ROOT_FILES =
    new Set([
        '/style.css',
        '/mobile.css',
        '/robots.txt',
        '/sitemap.xml',
        '/favicon.ico'
    ]);

const PUBLIC_STATIC_PREFIXES = [
    '/assets/',
    '/config/',
    '/data/',
    '/js/',
    '/locales/',
    '/maps/',
    '/styles/'
];

function parseBooleanEnvironment(
    value,
    fallback
) {
    if (
        value === undefined ||
        value === null ||
        String(value).trim() === ''
    ) {
        return fallback;
    }

    const normalized =
        String(value)
            .trim()
            .toLowerCase();

    if (
        ['1', 'true', 'yes', 'on'].includes(
            normalized
        )
    ) {
        return true;
    }

    if (
        ['0', 'false', 'no', 'off'].includes(
            normalized
        )
    ) {
        return false;
    }

    throw new Error(
        `Invalid boolean environment value: ${value}`
    );
}

const DISABLE_DEV_ANALYTICS =
    parseBooleanEnvironment(
        process.env.WARDOGS_DISABLE_ANALYTICS,
        true
    );

const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8'
};

const LIVE_RELOAD_CLIENT = `
<script data-wardogs-dev-reload>
(() => {
    const source = new EventSource('/__dev/reload');

    source.onmessage = event => {
        if (event.data === 'reload') {
            window.location.reload();
        }
    };
})();
</script>`;

function getArgument(name) {
    const args =
        process.argv.slice(2);

    const equalsPrefix =
        `${name}=`;

    for (
        let index = 0;
        index < args.length;
        index++
    ) {
        const argument =
            args[index];

        if (
            argument.startsWith(
                equalsPrefix
            )
        ) {
            return argument.slice(
                equalsPrefix.length
            );
        }

        if (
            argument === name
        ) {
            return args[index + 1];
        }
    }

    return null;
}

function resolveHost() {
    return (
        getArgument('--host') ||
        process.env.HOST ||
        DEFAULT_HOST
    );
}

function resolvePort() {
    const raw =
        getArgument('--port') ||
        process.env.PORT ||
        String(DEFAULT_PORT);

    const port =
        Number(raw);

    if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535
    ) {
        throw new Error(
            `Invalid dev server port: ${raw}`
        );
    }

    return port;
}

async function exists(path) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

function directoryExists(path) {
    try {
        return statSync(path)
            .isDirectory();
    } catch {
        return false;
    }
}

function renderMobileLocale(
    template,
    language
) {
    const isDefault =
        language === 'en';

    const desktopCanonical =
        isDefault
            ? 'https://wardogs-artillery.com/'
            : `https://wardogs-artillery.com/${language}/`;

    const baseHref =
        isDefault
            ? '../'
            : '../../';

    return template
        .replace(
            '<html data-page-language="en" lang="en">',
            `<html data-page-language="${language}" lang="${language}">`
        )
        .replace(
            '<base href="../"/>',
            `<base href="${baseHref}"/>`
        )
        .replace(
            '<link href="https://wardogs-artillery.com/" rel="canonical"/>',
            `<link href="${desktopCanonical}" rel="canonical"/>`
        )
        .replace(
            'href="../?desktop=1"',
            `href="${desktopCanonical}?desktop=1"`
        );
}

async function getLanguageDefinitions() {
    const index =
        JSON.parse(
            await readFile(
                join(
                    root,
                    'locales',
                    'index.json'
                ),
                'utf8'
            )
        );

    const configured =
        Array.isArray(
            index.languages
        )
            ? index.languages
                .filter(item => item?.id && item?.file)
                .map(item => ({
                    ...item,
                    id: String(item.id).toLowerCase(),
                    hreflang: item.hreflang || item.id,
                    ogLocale: item.ogLocale || null,
                    indexable: item.indexable !== false
                }))
            : [];

    return configured;
}

async function getLanguages() {
    return new Set(
        (await getLanguageDefinitions())
            .map(definition => definition.id)
    );
}

function prepareDevHTML(html) {
    let prepared = html;

    if (DISABLE_DEV_ANALYTICS) {
        /*
         * Keep local development out of production analytics and tell
         * the application wrapper not to queue events while disabled.
         */
        prepared = prepared.replace(
            /\s*<script[^>]*src=["']js\/core\/analytics-loader\.js(?:\?[^"']*)?["'][^>]*><\/script>/gi,
            ''
        );

        prepared = prepared.replace(
            '<head>',
            '<head>\n<script>window.__WARDOGS_ANALYTICS_DISABLED__ = true;</script>'
        );
    } else {
        prepared = prepared.replace(
            '<head>',
            '<head>\n<script>window.__WARDOGS_ANALYTICS_ALLOW_LOCAL__ = true;</script>'
        );
    }

    if (prepared.includes('</body>')) {
        return prepared.replace(
            '</body>',
            `${LIVE_RELOAD_CLIENT}\n</body>`
        );
    }

    return (
        `${prepared}\n` +
        LIVE_RELOAD_CLIENT
    );
}

function renderDesktopGuideLocale(html, language) {
    const copy =
        SEO_PAGE_CONTENT[language] ||
        SEO_PAGE_CONTENT.en;

    const withContent = html.replace(
        '<!-- SEO_GUIDE_CONTENT -->',
        renderSeoGuideContent(copy)
    );

    const guideStyles =
        '<link href="styles/desktop/seo.css" rel="stylesheet"/>';

    if (withContent.includes(guideStyles)) {
        return withContent;
    }

    return withContent.replace(
        '</head>',
        `${guideStyles}\n</head>`
    );
}

function sendText(
    response,
    statusCode,
    body,
    contentType =
        'text/plain; charset=utf-8'
) {
    response.writeHead(
        statusCode,
        {
            'Content-Type':
                contentType,

            'Cache-Control':
                'no-store, max-age=0',

            'X-Content-Type-Options':
                'nosniff',

            'Referrer-Policy':
                'no-referrer'
        }
    );

    response.end(body);
}

async function sendHTML(
    response,
    path,
    transform = null
) {
    let html =
        await readFile(
            path,
            'utf8'
        );

    if (transform) {
        html =
            transform(html);
    }

    sendText(
        response,
        200,
        prepareDevHTML(html),
        'text/html; charset=utf-8'
    );
}

function publicStaticPathname(pathname) {
    let decoded;

    try {
        decoded =
            decodeURIComponent(
                pathname
            );
    } catch {
        return null;
    }

    if (
        decoded.includes('\\') ||
        decoded.includes('\0')
    ) {
        return null;
    }

    const segments =
        decoded
            .split('/')
            .filter(Boolean);

    if (
        segments.some(
            segment =>
                segment === '.' ||
                segment === '..' ||
                segment.startsWith('.')
        )
    ) {
        return null;
    }

    const normalizedPathname =
        `/${segments.join('/')}`;

    if (
        !PUBLIC_STATIC_ROOT_FILES.has(
            normalizedPathname
        ) &&
        !PUBLIC_STATIC_PREFIXES.some(
            prefix =>
                normalizedPathname.startsWith(
                    prefix
                )
        )
    ) {
        return null;
    }

    return normalizedPathname;
}

function safeStaticPath(pathname) {
    const publicPathname =
        publicStaticPathname(
            pathname
        );

    if (!publicPathname) {
        return null;
    }

    const relative =
        normalize(
            publicPathname.replace(
                /^\/+/, 
                ''
            )
        );

    const absolute =
        resolve(
            root,
            relative
        );

    if (
        absolute !== root &&
        !absolute.startsWith(
            `${root}${sep}`
        )
    ) {
        return null;
    }

    return absolute;
}

async function sendStatic(
    response,
    pathname
) {
    const path =
        safeStaticPath(
            pathname
        );

    if (
        !path ||
        !(await exists(path))
    ) {
        return false;
    }

    const info =
        await stat(path);

    if (!info.isFile()) {
        return false;
    }

    const canonicalRoot =
        await realpath(root);

    const canonicalPath =
        await realpath(path);

    if (
        canonicalPath !== canonicalRoot &&
        !canonicalPath.startsWith(
            `${canonicalRoot}${sep}`
        )
    ) {
        return false;
    }

    const contentType =
        MIME_TYPES[
            extname(path)
                .toLowerCase()
        ] ||
        'application/octet-stream';

    response.writeHead(
        200,
        {
            'Content-Type':
                contentType,

            'Content-Length':
                info.size,

            'Cache-Control':
                'no-store, max-age=0',

            'X-Content-Type-Options':
                'nosniff',

            'Referrer-Policy':
                'no-referrer'
        }
    );

    createReadStream(path)
        .pipe(response);

    return true;
}

function sendJSON(response, value) {
    const body = JSON.stringify(value);

    response.writeHead(
        200,
        {
            'Content-Type':
                'application/json; charset=utf-8',
            'Content-Length':
                Buffer.byteLength(body),
            'Cache-Control':
                'no-store, max-age=0',
            'X-Content-Type-Options':
                'nosniff',
            'Referrer-Policy':
                'no-referrer'
        }
    );

    response.end(body);
}

/*
 * Local self-hosted tiles: when a placeholder pyramid exists under
 * maps/tiles/, serve map and gateway configurations that point at it
 * instead of the production asset CDN, which cannot authorize local
 * development origins. Tracked files keep their production shape.
 */
const LOCAL_TILES_DIRECTORY =
    join(root, 'maps', 'tiles');

const LOCAL_TERRAIN_DIRECTORY =
    join(root, 'data', 'terrain');

function localTilePyramidMaxZoom(directory) {
    for (let zoom = 7; zoom >= 0; zoom--) {
        if (directoryExists(join(directory, `zoom_${zoom}`))) {
            return zoom;
        }
    }

    return -1;
}

/*
 * Restored real pyramids use WebP tiles; placeholder pyramids
 * use PNG. Both can coexist inside one pyramid directory while a
 * local copy is assembled, so prefer WebP when the deepest zoom
 * level contains it.
 */
function localTilePyramidExtension(directory, maxZoom) {
    try {
        const entries =
            readdirSync(
                join(directory, `zoom_${maxZoom}`)
            );

        for (const entry of entries) {
            if (entry.endsWith('.webp')) {
                return 'webp';
            }
        }
    } catch {
        /* Unreadable directory: keep the placeholder default. */
    }

    return 'png';
}

function localTileStyleForDirectory(pyramidPath, directory) {
    const maxZoom =
        localTilePyramidMaxZoom(directory);

    if (maxZoom < 0) {
        return null;
    }

    return {
        path: pyramidPath,
        extension: localTilePyramidExtension(directory, maxZoom),
        maxZoom
    };
}

const LOCAL_REVISION_PATTERN =
    /\/revisions\/([a-z0-9][a-z0-9-]{0,47})$/;

/*
 * Prefer a local pyramid placed for the exact production revision
 * (maps/tiles/<map>/revisions/<rev>/), then fall back to the bare
 * restored or placeholder pyramid so imagery revisions never mix.
 */
function localTileStyleForProductionPath(productionPath, mapId, suffix = '') {
    const revision =
        typeof productionPath === 'string' &&
        productionPath.match(LOCAL_REVISION_PATTERN);

    if (revision) {
        const revisionPath =
            `maps/tiles/${mapId}${suffix}/revisions/${revision[1]}`;

        const style =
            localTileStyleForDirectory(
                revisionPath,
                join(root, revisionPath)
            );

        if (style) {
            return style;
        }
    }

    const fallbackPath =
        `maps/tiles/${mapId}${suffix}`;

    return localTileStyleForDirectory(
        fallbackPath,
        join(root, fallbackPath)
    );
}

async function sendLocalMapJson(response, mapId) {
    const sourcePath =
        join(root, 'maps', `${mapId}.json`);

    if (!(await exists(sourcePath))) {
        return false;
    }

    const map =
        JSON.parse(await readFile(sourcePath, 'utf8'));

    const productionStyles =
        map.tiles?.styles || {};

    const grayscale =
        localTileStyleForProductionPath(
            productionStyles.grayscale?.path || map.tiles?.path,
            mapId
        );

    if (!grayscale) {
        return false;
    }

    const styles = { grayscale };

    const color =
        localTileStyleForProductionPath(
            productionStyles.color?.path,
            mapId,
            '-color'
        );

    if (color) {
        styles.color = color;
    }

    map.tiles = {
        ...map.tiles,
        ...grayscale,
        tileSize: 256,
        styles
    };

    sendJSON(response, map);
    return true;
}

async function sendLocalConfigJson(response) {
    const sourcePath =
        join(root, 'config', 'app.json');

    if (!(await exists(sourcePath))) {
        return false;
    }

    const config =
        JSON.parse(await readFile(sourcePath, 'utf8'));

    config.assetGateway = {
        ...config.assetGateway,
        enabled: false,
        origin: 'https://local-assets.invalid',
        directOrigin: 'https://local-assets.invalid'
    };

    sendJSON(response, config);
    return true;
}

/*
 * Local terrain datasets: restored Terrain3D chunks stay under
 * data/terrain/<map-id>/chunks/. A restored dataset can differ from
 * the tracked manifest (the recoverable Bakurani chunks predate the
 * season-2 release), so a manifest.local.json side file describes
 * the binaries actually on disk and takes precedence.
 */
async function localTerrainManifest(mapId) {
    const mapDirectory =
        join(LOCAL_TERRAIN_DIRECTORY, mapId);

    if (!directoryExists(join(mapDirectory, 'chunks'))) {
        return null;
    }

    const localManifestPath =
        join(mapDirectory, 'manifest.local.json');

    if (await exists(localManifestPath)) {
        return `data/terrain/${mapId}/manifest.local.json`;
    }

    const trackedManifestPath =
        join(mapDirectory, 'manifest.json');

    return await exists(trackedManifestPath)
        ? `data/terrain/${mapId}/manifest.json`
        : null;
}

async function sendLocalTerrainContextJson(response) {
    const sourcePath =
        join(root, 'data', 'ballistics', 'terrain-context.json');

    if (!(await exists(sourcePath))) {
        return false;
    }

    const config =
        JSON.parse(await readFile(sourcePath, 'utf8'));

    const manifests = new Map();

    for (const mapId of Object.keys(config.terrainMaps || {})) {
        const manifest =
            await localTerrainManifest(mapId);

        if (manifest) {
            manifests.set(mapId, manifest);
        }
    }

    if (!manifests.size) {
        return false;
    }

    if (
        config.mapId &&
        manifests.has(config.mapId)
    ) {
        config.terrainManifest =
            manifests.get(config.mapId);
    }

    for (
        const [mapId, definition] of
            Object.entries(config.terrainMaps || {})
    ) {
        const manifest =
            manifests.get(mapId);

        if (!manifest) {
            continue;
        }

        config.terrainMaps[mapId] =
            typeof definition === 'string'
                ? manifest
                : {
                    ...definition,
                    terrainManifest: manifest
                };
    }

    sendJSON(response, config);
    return true;
}

async function sendLocalAssetOverride(response, pathname) {
    if (
        !directoryExists(LOCAL_TILES_DIRECTORY) &&
        !directoryExists(LOCAL_TERRAIN_DIRECTORY)
    ) {
        return false;
    }

    if (pathname === '/config/app.json') {
        return sendLocalConfigJson(response);
    }

    if (pathname === '/data/ballistics/terrain-context.json') {
        return sendLocalTerrainContextJson(response);
    }

    const mapMatch =
        pathname.match(/^\/maps\/([a-z0-9-]+)\.json$/);

    if (mapMatch) {
        return sendLocalMapJson(response, mapMatch[1]);
    }

    return false;
}

function requestHostAllowed(request) {
    const value =
        request.headers.host;

    if (!value) {
        return false;
    }

    try {
        const parsed =
            new URL(
                `http://${value}`
            );

        const hostname =
            parsed.hostname.replace(
                /^\[|\]$/g,
                ''
            );

        if (
            parsed.username ||
            parsed.password
        ) {
            return false;
        }

        if (
            parsed.port &&
            Number(parsed.port) !== port
        ) {
            return false;
        }

        const wildcard =
            host === '0.0.0.0' ||
            host === '::';

        if (wildcard) {
            return (
                hostname === 'localhost' ||
                Boolean(isIP(hostname))
            );
        }

        if (hostname === host) {
            return true;
        }

        return (
            hostname === 'localhost' &&
            ['127.0.0.1', '::1', 'localhost']
                .includes(host)
        );
    } catch {
        return false;
    }
}

const reloadClients =
    new Set();

function connectReloadClient(
    request,
    response
) {
    response.writeHead(
        200,
        {
            'Content-Type':
                'text/event-stream',

            'Cache-Control':
                'no-cache, no-transform',

            'Connection':
                'keep-alive'
        }
    );

    response.write(
        'retry: 500\n'
    );

    response.write(
        'data: connected\n\n'
    );

    reloadClients.add(
        response
    );

    request.on(
        'close',
        () => {
            reloadClients.delete(
                response
            );
        }
    );
}

let reloadTimer =
    null;

function queueReload(changedPath) {
    clearTimeout(
        reloadTimer
    );

    reloadTimer =
        setTimeout(
            () => {
                console.log(
                    `[reload] ${changedPath}`
                );

                for (
                    const client
                    of reloadClients
                ) {
                    client.write(
                        'data: reload\n\n'
                    );
                }
            },
            80
        );
}

function watchDirectory(
    relativePath,
    recursive = true
) {
    const target =
        join(
            root,
            relativePath
        );

    if (
        !directoryExists(target)
    ) {
        return null;
    }

    try {
        return watch(
            target,
            { recursive },
            (
                _eventType,
                filename
            ) => {
                const changed =
                    filename
                        ? `${relativePath}/${filename}`
                        : relativePath;

                queueReload(
                    changed.replaceAll(
                        '\\',
                        '/'
                    )
                );
            }
        );
    } catch (error) {
        console.warn(
            `[dev] Unable to watch ${relativePath}: ${error.message}`
        );

        return null;
    }
}

function watchRootFiles() {
    const watched =
        new Set([
            'style.css',
            'mobile.css'
        ]);

    try {
        return watch(
            root,
            {
                recursive: false
            },
            (
                _eventType,
                filename
            ) => {
                if (
                    filename &&
                    watched.has(
                        filename.toString()
                    )
                ) {
                    queueReload(
                        filename.toString()
                    );
                }
            }
        );
    } catch (error) {
        console.warn(
            `[dev] Unable to watch root CSS entry points: ${error.message}`
        );

        return null;
    }
}

async function createRequestHandler() {
    const mobileTemplatePath =
        join(
            root,
            'src',
            'pages',
            'mobile',
            'index.html'
        );

    const mapTemplatePath =
        join(
            root,
            'src',
            'pages',
            'maps',
            'template.html'
        );

    return async (
        request,
        response
    ) => {
        try {
            if (!requestHostAllowed(request)) {
                sendText(
                    response,
                    403,
                    'Forbidden host.'
                );

                return;
            }

            if (request.method !== 'GET') {
                sendText(
                    response,
                    405,
                    'Method not allowed.'
                );

                return;
            }

            const url =
                new URL(
                    request.url,
                    'http://localhost'
                );

            const pathname =
                url.pathname;

            if (
                pathname ===
                '/__dev/reload'
            ) {
                connectReloadClient(
                    request,
                    response
                );

                return;
            }

            if (
                pathname === '/' ||
                pathname === '/index.html'
            ) {
                await sendHTML(
                    response,
                    join(
                        root,
                        'src',
                        'pages',
                        'index.html'
                    ),
                    template =>
                        renderDesktopGuideLocale(
                            template,
                            'en'
                        )
                );

                return;
            }

            const mapLandingMatch =
                pathname.match(
                    /^\/(?:(?<language>[a-z-]+)\/)?maps\/(?<map>[a-z0-9-]+)(?:\/index\.html)?\/?$/i
                );

            if (mapLandingMatch) {
                const language = (mapLandingMatch.groups.language || 'en')
                    .toLowerCase();
                const mapId = mapLandingMatch.groups.map.toLowerCase();
                const definitions = await getLanguageDefinitions();
                const definition = definitions.find(item => item.id === language);
                const page = definition && hasMapLandingLanguage(language)
                    ? mapLandingPageById(mapId, language)
                    : null;

                if (page) {
                    await sendHTML(
                        response,
                        mapTemplatePath,
                        template =>
                            renderMapLandingPage(
                                template,
                                page,
                                {
                                    languageDefinition: definition,
                                    languages: definitions
                                }
                            )
                    );

                    return;
                }
            }

            const mobileMatch =
                pathname.match(
                    /^\/mobile(?:\/([a-z-]+))?\/?$/i
                );

            const mobileIndexMatch =
                pathname.match(
                    /^\/mobile(?:\/([a-z-]+))?\/index\.html$/i
                );

            const matchedMobileRoute =
                mobileMatch ||
                mobileIndexMatch;

            if (matchedMobileRoute) {
                const language =
                    matchedMobileRoute[1] ||
                    'en';

                const languages =
                    await getLanguages();

                if (
                    !languages.has(
                        language
                    )
                ) {
                    sendText(
                        response,
                        404,
                        'Unknown mobile language.'
                    );

                    return;
                }

                await sendHTML(
                    response,
                    mobileTemplatePath,
                    template =>
                        renderMobileLocale(
                            template,
                            language
                        )
                );

                return;
            }

            const desktopMatch =
                pathname.match(
                    /^\/([a-z-]+)(?:\/index\.html)?\/?$/i
                );

            if (desktopMatch) {
                const language =
                    desktopMatch[1];

                const languages =
                    await getLanguages();

                if (
                    language !== 'en' &&
                    languages.has(language)
                ) {
                    const localePath =
                        join(
                            root,
                            'src',
                            'pages',
                            'locales',
                            `${language}.html`
                        );

                    if (
                        await exists(
                            localePath
                        )
                    ) {
                        await sendHTML(
                            response,
                            localePath,
                            template =>
                                renderDesktopGuideLocale(
                                    template,
                                    language
                                )
                        );

                        return;
                    }
                }
            }

            if (
                await sendLocalAssetOverride(
                    response,
                    pathname
                )
            ) {
                return;
            }

            if (
                await sendStatic(
                    response,
                    pathname
                )
            ) {
                return;
            }

            sendText(
                response,
                404,
                'Not found.'
            );
        } catch (error) {
            console.error(error);

            sendText(
                response,
                500,
                'Development server error.'
            );
        }
    };
}

const host =
    resolveHost();

const port =
    resolvePort();

const requestHandler =
    await createRequestHandler();

const server =
    createServer(
        requestHandler
    );

const watchers = [
    watchDirectory('js'),
    watchDirectory('styles'),
    watchDirectory('src/pages'),
    watchDirectory('locales'),
    watchDirectory('config'),
    watchDirectory('data'),
    watchDirectory('assets'),

    /*
     * Watch only the top-level map config directory.
     * The huge tile pyramid is intentionally not watched.
     * Tile files are still served directly from disk and are visible
     * immediately after a manual page refresh.
     */
    watchDirectory(
        'maps',
        false
    ),

    watchRootFiles()
].filter(Boolean);

function shutdown() {
    for (
        const watcher
        of watchers
    ) {
        watcher.close();
    }

    for (
        const client
        of reloadClients
    ) {
        client.end();
    }

    server.close(
        () => process.exit(0)
    );
}

process.on(
    'SIGINT',
    shutdown
);

process.on(
    'SIGTERM',
    shutdown
);

server.listen(
    port,
    host,
    () => {
        const displayHost =
            host === '0.0.0.0'
                ? 'localhost'
                : host;

        console.log('');
        console.log(
            'WARDOGS development server'
        );
        console.log(
            `Desktop: http://${displayHost}:${port}/`
        );
        console.log(
            `Mobile:  http://${displayHost}:${port}/mobile/`
        );
        console.log('');
        console.log(
            DISABLE_DEV_ANALYTICS
                ? 'Live reload enabled. Production GoatCounter analytics disabled.'
                : 'Live reload enabled. Production GoatCounter analytics ENABLED for this dev session.'
        );
        console.log(
            'Map tiles are served directly and are not watched for changes.'
        );
        console.log(
            'Press Ctrl+C to stop.'
        );
        console.log('');
    }
);
