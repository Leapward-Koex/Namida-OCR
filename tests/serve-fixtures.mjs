import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const port = Number(process.argv[2] ?? process.env.PLAYWRIGHT_FIXTURE_PORT ?? 3210);
const root = path.resolve(process.cwd(), 'tests', 'fixtures');

const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml'],
    ['.css', 'text/css; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
]);

const server = http.createServer(async (request, response) => {
    try {
        const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host}`);
        const pathname = requestUrl.pathname === '/' ? '/ocr-page.html' : decodeURIComponent(requestUrl.pathname);
        const filePath = path.resolve(root, `.${pathname}`);

        if (!filePath.startsWith(root)) {
            response.writeHead(403);
            response.end('Forbidden');
            return;
        }

        const body = await readFile(filePath);
        const extension = path.extname(filePath).toLowerCase();

        response.writeHead(200, {
            'Content-Type': contentTypes.get(extension) ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        response.end(body);
    } catch {
        response.writeHead(404);
        response.end('Not found');
    }
});

server.listen(port, '127.0.0.1', () => {
    console.log(`Fixture server listening on http://127.0.0.1:${port}`);
});
